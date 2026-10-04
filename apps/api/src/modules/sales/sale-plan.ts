import { currencyExponent, isKnownCurrency } from '@flower/money';
import { isProviderBackedTender, isTenderMethod, type TenderMethod } from '../payments/tender.js';

/**
 * Task 3b.9 Checkpoint A (A2) — the PURE sale-plan validator.
 *
 * Takes the finalized computed invoice total (from `computeCanonicalTotals`)
 * and the requested payment intent / tenders / advance applications, and
 * returns ONE deterministic, validated {@link SalePlan} — or throws a
 * {@link SalePlanError} carrying the exact `DomainError` code + HTTP status the
 * orchestrator (Checkpoint C) maps it to. No DB, no clock, no randomness, no
 * side effect, no provider call: value in / value out over BigInt.
 *
 * FROZEN rules (owner rulings OD-1, OD-2, OD-6/D3b-6, OD-9, "fully resolved"):
 *
 *   PAY_NOW    tender + advance application == the final total EXACTLY;
 *              final outstanding is 0.
 *   ON_CREDIT  an identified customer is REQUIRED; any provided tenders /
 *              advance applications are applied; final outstanding is > 0 (the
 *              remainder is the customer's receivable). (The credit-limit gate
 *              itself runs later, under lock, inside invoice issuance.)
 *   Anonymous  (`customerId = null`): PAY_NOW only, zero final outstanding, no
 *              CustomerAdvance, no credit.
 *   Credit is NEVER a payment / tender: `CREDIT`, `ADVANCE`, `WALLET`,
 *              `STORE_CREDIT`, … are not tender methods and are rejected.
 *   Tenders    only locally confirmable ones — CASH, BANK_TRANSFER,
 *              OTHER_MANUAL, and the manual (non-provider) CARD_TERMINAL slip.
 *              ONLINE_GATEWAY and any provider-backed terminal are rejected:
 *              no external provider I/O may occur inside the atomic sale.
 *   Money      positive exact BigInt only — no change-making, no cash rounding,
 *              no overpayment (the applied amount is exact; Phase 4 owns cash
 *              rounding / change), the sale currency / exponent must match
 *              every component exactly, and a zero-value sale is not supported
 *              (no journal can be posted for it).
 *
 * The plan is the single input the later checkpoints consume: the orchestrator
 * applies `advances` (ascending `advanceId` — the canonical lock order) and
 * `tenders` (request order) and the walk-in journal builder consumes
 * `tenders` + `totalAmountMinor`.
 */

export type SaleIntent = 'PAY_NOW' | 'ON_CREDIT';

export const SALE_INTENTS: readonly SaleIntent[] = Object.freeze(['PAY_NOW', 'ON_CREDIT']);

export type SalePlanErrorCode =
  | 'SALE_INTENT_INVALID'
  | 'SALE_TOTAL_INVALID'
  | 'SALE_ZERO_TOTAL_NOT_SUPPORTED'
  | 'SALE_CUSTOMER_INVALID'
  | 'SALE_CREDIT_REQUIRES_CUSTOMER'
  | 'SALE_ADVANCE_REQUIRES_CUSTOMER'
  | 'SALE_DUPLICATE_ADVANCE'
  | 'SALE_ADVANCE_INVALID'
  | 'SALE_TENDER_METHOD_UNSUPPORTED'
  | 'SALE_OVERPAYMENT_NOT_ALLOWED'
  | 'SALE_NOT_FULLY_RESOLVED'
  | 'SALE_ON_CREDIT_FULLY_COVERED'
  | 'SALE_PLAN_INVARIANT_VIOLATED'
  // reused, already-frozen payment codes (3b.5):
  | 'PAYMENT_INVALID_AMOUNT'
  | 'PAYMENT_CURRENCY_MISMATCH'
  | 'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT';

/**
 * A validation failure of the sale plan. Extends `RangeError` (the repository's
 * established convention for DB/HTTP-free pure modules) and carries the
 * intended `DomainError` code + status, so the orchestrator maps it by `code`
 * — never by matching a message string.
 */
export class SalePlanError extends RangeError {
  readonly code: SalePlanErrorCode;
  readonly httpStatus: number;
  constructor(code: SalePlanErrorCode, message: string, httpStatus = 422) {
    super(message);
    this.name = 'SalePlanError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface SaleTotalInput {
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly currencyExponent: number;
}

export interface SaleTenderRequest {
  /** deliberately a plain string: an unknown / forbidden value must be
   *  representable so it can be rejected rather than made unrepresentable. */
  readonly method: string;
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  /** INTERNAL trust-boundary field (mirrors `SynchronousTenderInput`): the
   *  public DTO has no field that can set it; a non-null value on a
   *  CARD_TERMINAL makes it provider-backed and is rejected. */
  readonly providerCredentialId?: string | null;
}

export interface SaleAdvanceRequest {
  readonly advanceId: string;
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly currencyExponent: number;
}

export interface PlanSaleInput {
  /** a plain string for the same reason as `SaleTenderRequest.method`. */
  readonly intent: string;
  /** `null` = anonymous WALK_IN (no placeholder customer, ever). */
  readonly customerId: string | null;
  readonly total: SaleTotalInput;
  readonly tenders: readonly SaleTenderRequest[];
  readonly advances: readonly SaleAdvanceRequest[];
}

export interface PlannedTender {
  readonly method: TenderMethod;
  readonly amountMinor: bigint;
}

export interface PlannedAdvance {
  readonly advanceId: string;
  readonly amountMinor: bigint;
}

export interface SalePlan {
  readonly intent: SaleIntent;
  readonly customerId: string | null;
  readonly anonymous: boolean;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly totalAmountMinor: bigint;
  /** in REQUEST order (the order the Payments are created in). */
  readonly tenders: readonly PlannedTender[];
  /** in ascending `advanceId` order — the canonical lock order for advances. */
  readonly advances: readonly PlannedAdvance[];
  readonly tenderTotalMinor: bigint;
  readonly advanceTotalMinor: bigint;
  readonly coveredMinor: bigint;
  /** total − covered: always 0 for PAY_NOW, always > 0 for ON_CREDIT. */
  readonly outstandingMinor: bigint;
  /** ON_CREDIT: the credit-limit gate must run at issuance. */
  readonly creditGateRequired: boolean;
  /** which accounting path books the sale: an anonymous sale needs the
   *  walk-in journal (Checkpoint B); a customer sale reuses the frozen 3b.6
   *  AR / receipt / allocation / advance journals untouched. */
  readonly journalPath: 'ANONYMOUS_WALK_IN' | 'CUSTOMER_RECEIVABLE';
}

const fail = (code: SalePlanErrorCode, message: string, status = 422): never => {
  throw new SalePlanError(code, message, status);
};

function assertPositiveBigInt(value: unknown, label: string): asserts value is bigint {
  if (typeof value !== 'bigint') {
    fail('PAYMENT_INVALID_AMOUNT', `${label} must be an exact BigInt minor-unit amount`);
  }
  if ((value as bigint) <= 0n) {
    fail('PAYMENT_INVALID_AMOUNT', `${label} must be > 0 (got ${String(value)})`);
  }
}

function assertSameCurrency(
  c: { readonly currencyCode: string; readonly currencyExponent: number },
  total: SaleTotalInput,
  label: string,
): void {
  if (c.currencyCode !== total.currencyCode || c.currencyExponent !== total.currencyExponent) {
    fail(
      'PAYMENT_CURRENCY_MISMATCH',
      `${label} currency ${c.currencyCode}/${c.currencyExponent} does not match the sale's ${total.currencyCode}/${total.currencyExponent}`,
    );
  }
}

export function planSale(input: PlanSaleInput): SalePlan {
  // ── 1. intent ─────────────────────────────────────────────────────────────
  if (!(SALE_INTENTS as readonly string[]).includes(input.intent)) {
    fail(
      'SALE_INTENT_INVALID',
      `paymentIntent must be PAY_NOW or ON_CREDIT (got ${String(input.intent)})`,
    );
  }
  const intent = input.intent as SaleIntent;

  // ── 2. the finalized total ────────────────────────────────────────────────
  const total = input.total;
  if (typeof total.amountMinor !== 'bigint') {
    fail('SALE_TOTAL_INVALID', 'the sale total must be an exact BigInt minor-unit amount');
  }
  if (
    typeof total.currencyCode !== 'string' ||
    !isKnownCurrency(total.currencyCode) ||
    currencyExponent(total.currencyCode) !== total.currencyExponent
  ) {
    fail(
      'SALE_TOTAL_INVALID',
      `the sale currency ${String(total.currencyCode)}/${String(total.currencyExponent)} is not a known currency / exponent pair`,
    );
  }
  if (total.amountMinor < 0n) fail('SALE_TOTAL_INVALID', 'the sale total must not be negative');
  if (total.amountMinor === 0n) {
    fail(
      'SALE_ZERO_TOTAL_NOT_SUPPORTED',
      'a zero-value sale is not supported (no balanced journal can be posted for it)',
    );
  }

  // ── 3. customer / anonymous restrictions (D3b-6) ─────────────────────────
  const customerId = input.customerId;
  if (customerId !== null && (typeof customerId !== 'string' || customerId.trim() === '')) {
    fail('SALE_CUSTOMER_INVALID', 'customerId must be null (anonymous) or a non-empty identifier');
  }
  const anonymous = customerId === null;
  if (anonymous && intent === 'ON_CREDIT') {
    fail(
      'SALE_CREDIT_REQUIRES_CUSTOMER',
      'a credit sale requires an identified customer — an anonymous sale must be paid in full',
    );
  }
  if (anonymous && input.advances.length > 0) {
    fail(
      'SALE_ADVANCE_REQUIRES_CUSTOMER',
      'a CustomerAdvance can only be applied to an identified customer — an anonymous sale cannot use one',
    );
  }

  // ── 4. tenders — locally confirmable only, exact positive money ──────────
  const tenders: PlannedTender[] = [];
  let tenderTotal = 0n;
  for (const [i, t] of input.tenders.entries()) {
    const label = `tenders[${i}]`;
    if (typeof t.method !== 'string' || !isTenderMethod(t.method)) {
      fail(
        'SALE_TENDER_METHOD_UNSUPPORTED',
        `${label}.method ${String(t.method)} is not a tender (credit and advances are never tenders)`,
      );
    }
    const method = t.method as TenderMethod;
    if (isProviderBackedTender(method, t.providerCredentialId ?? null)) {
      fail(
        'PAYMENT_ASYNC_TENDER_NOT_ALLOWED_IN_ATOMIC_MULTI_PAYMENT',
        `${label} (${method}${t.providerCredentialId ? ', provider-backed' : ''}) requires the async PaymentAttempt/provider flow and cannot participate in an atomic sale`,
      );
    }
    assertPositiveBigInt(t.amountMinor, `${label}.amountMinor`);
    assertSameCurrency(t, total, label);
    tenders.push({ method, amountMinor: t.amountMinor });
    tenderTotal += t.amountMinor;
  }

  // ── 5. advance applications — exact positive money, one per advance ──────
  const seenAdvances = new Set<string>();
  const advances: PlannedAdvance[] = [];
  let advanceTotal = 0n;
  for (const [i, a] of input.advances.entries()) {
    const label = `advances[${i}]`;
    if (typeof a.advanceId !== 'string' || a.advanceId.trim() === '') {
      fail('SALE_ADVANCE_INVALID', `${label}.advanceId must be a non-empty identifier`);
    }
    if (seenAdvances.has(a.advanceId)) {
      fail('SALE_DUPLICATE_ADVANCE', `${label}: advance ${a.advanceId} is applied more than once`);
    }
    seenAdvances.add(a.advanceId);
    assertPositiveBigInt(a.amountMinor, `${label}.amountMinor`);
    assertSameCurrency(a, total, label);
    advances.push({ advanceId: a.advanceId, amountMinor: a.amountMinor });
    advanceTotal += a.amountMinor;
  }
  advances.sort((x, y) => (x.advanceId < y.advanceId ? -1 : x.advanceId > y.advanceId ? 1 : 0));

  // ── 6. coverage — exact, never over ───────────────────────────────────────
  const covered = tenderTotal + advanceTotal;
  if (covered > total.amountMinor) {
    fail(
      'SALE_OVERPAYMENT_NOT_ALLOWED',
      `tenders + advances (${covered}) exceed the sale total (${total.amountMinor}) — change-making and overpayment are not supported`,
    );
  }
  const outstanding = total.amountMinor - covered;
  if (intent === 'PAY_NOW' && outstanding !== 0n) {
    fail(
      'SALE_NOT_FULLY_RESOLVED',
      `a PAY_NOW sale must be covered exactly: tenders + advances ${covered} of ${total.amountMinor} (short by ${outstanding})`,
    );
  }
  if (intent === 'ON_CREDIT' && outstanding === 0n) {
    fail(
      'SALE_ON_CREDIT_FULLY_COVERED',
      'an ON_CREDIT sale must leave a remaining balance — a fully covered sale is PAY_NOW',
    );
  }

  const plan: SalePlan = Object.freeze({
    intent,
    customerId,
    anonymous,
    currencyCode: total.currencyCode,
    currencyExponent: total.currencyExponent,
    totalAmountMinor: total.amountMinor,
    tenders: Object.freeze(tenders),
    advances: Object.freeze(advances),
    tenderTotalMinor: tenderTotal,
    advanceTotalMinor: advanceTotal,
    coveredMinor: covered,
    outstandingMinor: outstanding,
    creditGateRequired: intent === 'ON_CREDIT',
    journalPath: anonymous ? 'ANONYMOUS_WALK_IN' : 'CUSTOMER_RECEIVABLE',
  });
  assertSalePlanConserved(plan);
  return plan;
}

/**
 * The conservation invariants of a finished plan, re-derived from its own
 * components (defence in depth — `planSale` already guarantees them; a future
 * edit that breaks one fails here, loudly, instead of producing a plan whose
 * numbers disagree).
 */
export function assertSalePlanConserved(plan: SalePlan): void {
  const tenderSum = plan.tenders.reduce((acc, t) => acc + t.amountMinor, 0n);
  const advanceSum = plan.advances.reduce((acc, a) => acc + a.amountMinor, 0n);
  const problems: string[] = [];
  if (tenderSum !== plan.tenderTotalMinor) problems.push('tender total != sum of tenders');
  if (advanceSum !== plan.advanceTotalMinor) problems.push('advance total != sum of advances');
  if (plan.tenderTotalMinor + plan.advanceTotalMinor !== plan.coveredMinor) {
    problems.push('covered != tenders + advances');
  }
  if (plan.coveredMinor + plan.outstandingMinor !== plan.totalAmountMinor) {
    problems.push('covered + outstanding != total');
  }
  if (plan.outstandingMinor < 0n) problems.push('outstanding is negative');
  if (plan.intent === 'PAY_NOW' && plan.outstandingMinor !== 0n) {
    problems.push('PAY_NOW leaves an outstanding balance');
  }
  if (plan.intent === 'ON_CREDIT' && plan.outstandingMinor <= 0n) {
    problems.push('ON_CREDIT leaves no outstanding balance');
  }
  if (plan.anonymous && (plan.intent !== 'PAY_NOW' || plan.advances.length > 0)) {
    problems.push('an anonymous sale is PAY_NOW with no advance');
  }
  if (problems.length > 0) {
    fail('SALE_PLAN_INVARIANT_VIOLATED', `sale plan is not conserved: ${problems.join('; ')}`, 500);
  }
}

import crypto from 'node:crypto';
import type pg from 'pg';

/**
 * Shared raw-SQL fixtures + the behaviour-case matrix for the Task 3b.8 hard-gate DB-integrity closure
 * (migration 49: currency authority O-1, credit-note-coverage-release scope / customer attribution O-2).
 *
 * The same cases drive BOTH suites:
 *   - `3b8-currency-release-integrity.integration.test.ts`   (a fresh database: every case's expectation),
 *   - `3b8-currency-release-integrity-migration.integration.test.ts` (a real 48 -> 49 upgrade: the SAME cases
 *     are run before and after the upgrade, so "accepted at 48, refused at 49" is proven on identical inputs).
 *
 * Case kinds:
 *   LEGIT  — a legitimate frozen flow: ACCEPTED before and after migration 49;
 *   KEEP   — refused by a PRE-EXISTING guard: refused before and after, with the SAME message;
 *   DEFECT — a raw-SQL integrity hole: ACCEPTED by the 48 schema, REFUSED by the 49 schema.
 *
 * A file in `test/helpers/` is not a test file (no `.test.` in its name) — vitest never collects it.
 */

export const TENANT = 'c1000000-8111-7111-8111-111111111111';
export const OTHER_TENANT = 'c2000000-8222-7222-8222-222222222222';
export const COMPANY = 'c3000000-8333-7333-8333-333333333333';
export const BRANCH = 'c6000000-8666-7666-8666-666666666666';
export const CATEGORY = 'c8000000-8888-7888-8888-888888888888';
export const PRODUCT = 'c9000000-8999-7999-8999-999999999999';
export const VARIANT = 'ca000000-8aaa-7aaa-8aaa-aaaaaaaaaaaa';
export const CUSTOMER = 'cb000000-8bbb-7bbb-8bbb-bbbbbbbbbbbb';
export const CCA = 'cc000000-8ccc-7ccc-8ccc-cccccccccccc';
export const CRED = 'cd000000-8ddd-7ddd-8ddd-dddddddddddd';

export const uid = (): string => crypto.randomUUID();

export type Kind = 'branch' | 'company' | 'tenant';
export const KINDS: readonly Kind[] = ['branch', 'company', 'tenant'];

export interface Scope {
  tenantId: string;
  companyId: string;
  branchId: string;
}
export interface Foreign extends Scope {
  ccaId: string;
  credId: string;
}
export const S0: Scope = { tenantId: TENANT, companyId: COMPANY, branchId: BRANCH };

export interface Money {
  code: string;
  exponent: number;
}
export const AED: Money = { code: 'AED', exponent: 2 };
export const USD: Money = { code: 'USD', exponent: 2 };
/** the right code with the WRONG exponent (the currency table says AED has 2) */
export const AED3: Money = { code: 'AED', exponent: 3 };

export type Run = (c: pg.PoolClient) => Promise<void>;

export interface Outcome {
  accepted: boolean;
  message: string;
}

/** ids / dates in a DB error vary per run — keep the SHAPE of the message only */
export const normalize = (msg: string): string =>
  msg.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');

/** attempt = run the statements in ONE transaction, force every deferred completeness trigger to run
 *  (SET CONSTRAINTS ALL IMMEDIATE) unless the case is judged on its statements alone, and either COMMIT or
 *  ROLLBACK. accepted = nothing raised. */
export async function attempt(
  p: pg.Pool,
  run: Run,
  commit: boolean,
  immediate = true,
): Promise<Outcome> {
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await run(c);
    if (immediate) await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return { accepted: true, message: '' };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    return { accepted: false, message: normalize(e instanceof Error ? e.message : String(e)) };
  } finally {
    c.release();
  }
}

/** a fingerprint (row count + md5 of the sorted row texts) of EVERY table except the migration ledger — so
 *  "no partial row, no projection change, no journal / audit side effect" is proven for the WHOLE database */
export async function fingerprint(p: pg.Pool): Promise<Record<string, string>> {
  const tables = (
    await p.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY 1`,
    )
  ).rows.map((r) => r.tablename);
  const out: Record<string, string> = {};
  for (const t of tables) {
    const r = await p.query<{ n: string; h: string }>(
      `SELECT count(*)::text AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`,
    );
    out[t] = `${r.rows[0]!.n}:${r.rows[0]!.h}`;
  }
  return out;
}

/** forge a row inside the CURRENT transaction only, with triggers off, then switch them back on */
export async function forge(c: pg.PoolClient, sql: string, params: unknown[]): Promise<void> {
  await c.query(`SET LOCAL session_replication_role = replica`);
  await c.query(sql, params);
  await c.query(`SET LOCAL session_replication_role = origin`);
}

/** forge a parent row's whole currency pair (`table` is a trusted literal) inside the CURRENT transaction */
export const forgeMoney = (c: pg.PoolClient, table: string, id: string, m: Money): Promise<void> =>
  forge(c, `UPDATE ${table} SET "currencyCode" = $2, "currencyExponent" = $3 WHERE id = $1`, [
    id,
    m.code,
    m.exponent,
  ]);

export interface ReleaseSpec {
  sourceKind: 'PAYMENT_ALLOCATION' | 'ADVANCE_APPLICATION' | 'OPENING_ADVANCE';
  allocationId?: string | null;
  applicationId?: string | null;
  paymentId?: string | null;
}

export interface IssueArgs {
  invoiceId: string;
  lineId: string;
  total: number;
  arReduction: number;
  advanceExcess: number;
  /** required when advanceExcess > 0 */
  release?: ReleaseSpec;
  /** the account the funded advance belongs to — default: the invoice customer's own account (else CCA) */
  advanceAccountId?: string;
  cnCurrency?: Money;
  /** default: the credit note's own currency */
  lineCurrency?: Money;
  /** the scope stamped on the release — default: the main scope */
  releaseScope?: Scope;
  /** runs after the credit note, its line and its advance exist and BEFORE the release is inserted */
  beforeRelease?: (c: pg.PoolClient, ids: { cnId: string; advanceId: string }) => Promise<void>;
}

export interface Issued {
  cnId: string;
  advanceId: string | null;
  releaseId: string | null;
}

/** the statement builders (explicit scope / currency) */
export const refundStmt = (
  c: pg.PoolClient,
  id: string,
  scope: Scope,
  paymentId: string,
  amount: number,
  method = 'BANK_TRANSFER',
  attemptId: string | null = null,
  money: Money = AED,
) =>
  c.query(
    `INSERT INTO refund (id,"tenantId","companyId","branchId","sourcePaymentId","sourceRefundAttemptId","amountMinor","currencyCode","currencyExponent",method,"reasonCode","accountingDate")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$9,$10,$8,'CUSTOMER_REQUEST',CURRENT_DATE)`,
    [
      id,
      scope.tenantId,
      scope.companyId,
      scope.branchId,
      paymentId,
      attemptId,
      amount,
      method,
      money.code,
      money.exponent,
    ],
  );

export const applicationStmt = (
  c: pg.PoolClient,
  scope: Scope,
  advanceId: string,
  refundId: string,
  amount: number,
  money: Money = AED,
) =>
  c.query(
    `INSERT INTO customer_advance_refund_application (id,"tenantId","companyId","branchId","customerAdvanceId","refundId","amountMinor","currencyCode","currencyExponent")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      uid(),
      scope.tenantId,
      scope.companyId,
      scope.branchId,
      advanceId,
      refundId,
      amount,
      money.code,
      money.exponent,
    ],
  );

export const attemptStmt = (
  c: pg.PoolClient,
  id: string,
  scope: Scope,
  paymentId: string,
  credId: string,
  amount: number,
  money: Money = AED,
) =>
  c.query(
    `INSERT INTO refund_attempt (id,"tenantId","companyId","branchId","sourcePaymentId","requestedAmountMinor","currencyCode","currencyExponent","providerCredentialId","providerKey","idempotencyKey","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$8,$9,$7,'tap',$10,now())`,
    [
      id,
      scope.tenantId,
      scope.companyId,
      scope.branchId,
      paymentId,
      amount,
      credId,
      money.code,
      money.exponent,
      `idem-${id}`,
    ],
  );

export const reservationStmt = (
  c: pg.PoolClient,
  scope: Scope,
  attemptId: string,
  releaseId: string,
  advanceId: string,
  amount: number,
  money: Money = AED,
) =>
  c.query(
    `INSERT INTO refund_attempt_entitlement_reservation (id,"tenantId","companyId","branchId","refundAttemptId","creditNoteCoverageReleaseId","customerAdvanceId","amountMinor","currencyCode","currencyExponent")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      uid(),
      scope.tenantId,
      scope.companyId,
      scope.branchId,
      attemptId,
      releaseId,
      advanceId,
      amount,
      money.code,
      money.exponent,
    ],
  );

export const EVENT_SQL = `INSERT INTO provider_refund_event (id,"tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","status","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,'refund.succeeded','hash-m49',$7,now())`;
export const eventStmt = (
  c: pg.PoolClient,
  id: string,
  scope: Scope,
  credId: string,
  status = 'RECEIVED',
  providerEventId: string = `evt-${id}`,
) =>
  c.query(EVENT_SQL, [
    id,
    scope.tenantId,
    scope.companyId,
    scope.branchId,
    credId,
    providerEventId,
    status,
  ]);

export class Fixtures {
  private seq = 0;
  private readonly runTag = uid().slice(0, 8);
  private readonly foreignMemo = new Map<Kind, Foreign>();

  constructor(readonly pool: pg.Pool) {}

  async baseFixture(): Promise<void> {
    const p = this.pool;
    await p.query(
      `INSERT INTO plan (id, key, name, "updatedAt") VALUES ('00000000-0000-7000-8000-000000000001', 'starter', 'Starter', now())`,
    );
    await p.query(
      `INSERT INTO plan_version (id, "planId", version, status, "updatedAt")
       VALUES ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 1, 'PUBLISHED', now())`,
    );
    for (const [id, slug] of [
      [TENANT, 'mig49'],
      [OTHER_TENANT, 'mig49-other'],
    ] as const) {
      await p.query(
        `INSERT INTO tenant (id, slug, name, region, status, "planVersionId", "updatedAt")
         VALUES ($1, $2, $2, 'AE', 'ACTIVE', '00000000-0000-7000-8000-000000000002', now())`,
        [id, slug],
      );
    }
    for (const [code, name] of [
      ['AED', 'UAE Dirham'],
      ['USD', 'US Dollar'],
    ] as const) {
      await p.query(
        `INSERT INTO currency (code, exponent, symbol, "nameEn", "nameAr")
         VALUES ($1, 2, $1, $2, $1) ON CONFLICT (code) DO NOTHING`,
        [code, name],
      );
    }
    await p.query(
      `INSERT INTO company (id, "tenantId", "legalNameEn", "defaultCurrency", "accountingTimezone", "updatedAt")
       VALUES ($1, $2, 'Mig Co', 'AED', 'Asia/Dubai', now())`,
      [COMPANY, TENANT],
    );
    await p.query(
      `INSERT INTO branch (id, "tenantId", "companyId", name, "updatedAt") VALUES ($1, $2, $3, 'Main', now())`,
      [BRANCH, TENANT, COMPANY],
    );
    await p.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Mig Customer', now())`,
      [CUSTOMER, TENANT],
    );
    await p.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [CCA, TENANT, COMPANY, CUSTOMER],
    );
    await p.query(
      `INSERT INTO category (id, "tenantId", slug, "nameEn", "updatedAt") VALUES ($1, $2, 'flowers', 'Flowers', now())`,
      [CATEGORY, TENANT],
    );
    await p.query(
      `INSERT INTO product (id, "tenantId", "categoryId", slug, "nameEn", "fulfilmentStrategy", "updatedAt")
       VALUES ($1, $2, $3, 'rose-bouquet', 'Test Product', 'STOCKED', now())`,
      [PRODUCT, TENANT, CATEGORY],
    );
    await p.query(
      `INSERT INTO variant (id, "tenantId", "productId", "nameEn", "updatedAt") VALUES ($1, $2, $3, 'Test Variant', now())`,
      [VARIANT, TENANT, PRODUCT],
    );
    await this.insertCredential(CRED, S0);
  }

  async insertCredential(
    id: string,
    scope: { tenantId: string; companyId: string | null; branchId: string | null },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_credential (id,"tenantId","companyId","branchId",provider,mode,"secretCiphertext","secretNonce","dekWrapped","updatedAt")
       VALUES ($1,$2,$3,$4,'tap','TEST','\\x00','\\x00','\\x00',now())`,
      [id, scope.tenantId, scope.companyId, scope.branchId],
    );
  }

  /** an order (DRAFT unless `confirm`) of the main scope, one line qty 1 / unit price = total */
  async simpleInvoice(
    totalMinor: number,
    customerId: string | null = CUSTOMER,
  ): Promise<{ orderId: string; lineId: string; invoiceId: string }> {
    const p = this.pool;
    const orderId = uid();
    await p.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", "customerId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "documentDiscountAmountMinor", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,'TAX_EXCLUSIVE','LINE','HALF_UP',0,now())`,
      [orderId, TENANT, COMPANY, BRANCH, customerId, `fp-${orderId}`],
    );
    const lineId = uid();
    await p.query(
      `INSERT INTO order_line
         (id, "tenantId", "companyId", "orderId", "linePosition", "productId", "variantId", quantity,
          "unitPriceAmountMinor", "unitPriceCurrencyCode", "unitPriceCurrencyExponent",
          "discountMode", "discountAmountMinor", "priceTaxMode", "roundingScope", "roundingMode", "lineTaxAmountMinor",
          "resolutionSource", "selectedUomCode", "uomDisplayLabelSnapshot", "baseUomCode",
          "conversionNumerator", "conversionDenominator", "productNameEnSnapshot", "variantNameEnSnapshot",
          "updatedAt")
       VALUES ($1,$2,$3,$4,1,$5,$6,'1.0000',$7,'AED',2,'NONE',0,'TAX_EXCLUSIVE','LINE','HALF_UP',0,
               'NONE','PIECE','Piece','PIECE',1,1,'Test Product','Test Variant', now())`,
      [lineId, TENANT, COMPANY, orderId, PRODUCT, VARIANT, totalMinor],
    );
    await p.query(
      `UPDATE "order" SET status = 'CONFIRMED', "orderNumber" = $2, version = version + 1 WHERE id = $1`,
      [orderId, `ORD-${this.runTag}-${(++this.seq).toString().padStart(6, '0')}`],
    );
    const invoiceId = uid();
    await p.query(
      `INSERT INTO invoice
         (id, "tenantId", "companyId", "branchId", "orderId", "invoiceNumber", "issuedAt",
          "invoiceDate", "currencyCode", "currencyExponent", "subtotalAmountMinor",
          "documentDiscountAmountMinor", "taxTotalAmountMinor", "totalAmountMinor")
       VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, 'AED', 2, $7, 0, 0, $7)`,
      [invoiceId, TENANT, COMPANY, BRANCH, orderId, `INV-${invoiceId.slice(0, 8)}`, totalMinor],
    );
    return { orderId, lineId, invoiceId };
  }

  async paymentWithAllocation(
    invoiceId: string,
    amountMinor: number,
  ): Promise<{ paymentId: string; allocationId: string }> {
    const p = this.pool;
    const attemptId = uid();
    await p.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "orderId", "targetInvoiceId", "receiptPurpose",
          method, "amountMinor", "currencyCode", "currencyExponent", state,
          "orderCommercialSnapshotFingerprintAtCreation", "orderVersionAtCreation",
          "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4, (SELECT "orderId" FROM invoice WHERE id=$5), $5,'INVOICE_COLLECTION',
               'BANK_TRANSFER',$6,'AED',2,'CAPTURED','fp',1,$7, now())`,
      [attemptId, TENANT, COMPANY, BRANCH, invoiceId, amountMinor, `idem-${attemptId}`],
    );
    const paymentId = uid();
    await p.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'BANK_TRANSFER',$6,'AED',2)`,
      [paymentId, TENANT, COMPANY, BRANCH, attemptId, amountMinor],
    );
    const allocationId = uid();
    await p.query(
      `INSERT INTO payment_allocation (id, "tenantId", "companyId", "branchId", "paymentId", "invoiceId", "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
      [allocationId, TENANT, COMPANY, BRANCH, paymentId, invoiceId, amountMinor],
    );
    return { paymentId, allocationId };
  }

  /** the account of the customer that owns the invoice's order (null for a walk-in order) */
  private async invoiceCustomerAccount(
    c: pg.PoolClient,
    invoiceId: string,
  ): Promise<string | null> {
    const r = await c.query<{ id: string }>(
      `SELECT cca.id FROM invoice i
         JOIN "order" o ON o.id = i."orderId"
         JOIN customer_company_account cca
           ON cca."customerId" = o."customerId" AND cca."companyId" = i."companyId" AND cca."tenantId" = i."tenantId"
        WHERE i.id = $1`,
      [invoiceId],
    );
    return r.rows[0]?.id ?? null;
  }

  /** a credit note (+ its line) over a `simpleInvoice`; funds ONE CREDIT_NOTE advance through ONE release when
   *  advanceExcess > 0. Runs on the caller's client — the caller owns BEGIN / COMMIT. */
  async issueCreditNoteTx(c: pg.PoolClient, a: IssueArgs): Promise<Issued> {
    const cn = a.cnCurrency ?? AED;
    const line = a.lineCurrency ?? cn;
    const cnId = uid();
    await c.query(
      `INSERT INTO credit_note
         (id, "tenantId", "companyId", "branchId", "invoiceId", "creditNoteNumber", "issuedAt",
          "accountingDate", "currencyCode", "currencyExponent", "reasonCode",
          "subtotalAmountMinor", "taxTotalAmountMinor", "totalAmountMinor",
          "arReductionMinor", "advanceExcessMinor")
       VALUES ($1,$2,$3,$4,$5,$6, now(), CURRENT_DATE, $10, $11, 'CUSTOMER_REQUEST', $7,0,$7,$8,$9)`,
      [
        cnId,
        TENANT,
        COMPANY,
        BRANCH,
        a.invoiceId,
        `CN-${cnId.slice(0, 8)}`,
        a.total,
        a.arReduction,
        a.advanceExcess,
        cn.code,
        cn.exponent,
      ],
    );
    await c.query(
      `INSERT INTO credit_note_line
         (id, "tenantId", "companyId", "creditNoteId", "orderLineId", "quantityCredited",
          "grossCreditedMinor", "discountCreditedMinor", "documentDiscountShareCreditedMinor",
          "netAfterDocumentDiscountCreditedMinor", "taxCreditedMinor", "lineTotalCreditedMinor",
          "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'1.0000',$6,0,0,$6,0,$6,$7,$8)`,
      [uid(), TENANT, COMPANY, cnId, a.lineId, a.total, line.code, line.exponent],
    );
    if (a.advanceExcess <= 0) return { cnId, advanceId: null, releaseId: null };
    if (!a.release) throw new Error('a release spec is required when advanceExcess > 0');
    const account =
      a.advanceAccountId ?? (await this.invoiceCustomerAccount(c, a.invoiceId)) ?? CCA;
    const advanceId = uid();
    await c.query(
      `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',$6,'AED',2)`,
      [advanceId, TENANT, COMPANY, BRANCH, account, a.advanceExcess],
    );
    if (a.beforeRelease) await a.beforeRelease(c, { cnId, advanceId });
    const scope = a.releaseScope ?? S0;
    const releaseId = uid();
    await c.query(
      `INSERT INTO credit_note_coverage_release
         (id,"tenantId","companyId","branchId","creditNoteId","sourceKind","sourcePaymentAllocationId","sourceAdvanceApplicationId","sourcePaymentId","releasedAmountMinor","currencyCode","currencyExponent","customerAdvanceId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'AED',2,$11)`,
      [
        releaseId,
        scope.tenantId,
        scope.companyId,
        scope.branchId,
        cnId,
        a.release.sourceKind,
        a.release.allocationId ?? null,
        a.release.applicationId ?? null,
        a.release.paymentId ?? null,
        a.advanceExcess,
        advanceId,
      ],
    );
    return { cnId, advanceId, releaseId };
  }

  /** a committed credit note — for fixtures that must exist BEFORE the attempt under test */
  async issueCreditNote(a: IssueArgs): Promise<Issued> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const issued = await this.issueCreditNoteTx(c, a);
      await c.query('COMMIT');
      return issued;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  /** a fresh CREDIT_NOTE advance of `amount`, funded by its own Payment (release provenance = that Payment) */
  async cnAdvance(
    amount: number,
    opts: { customerId?: string | null; advanceAccountId?: string } = {},
  ): Promise<{
    paymentId: string;
    advanceId: string;
    releaseId: string;
    invoiceId: string;
    lineId: string;
  }> {
    const { lineId, invoiceId } = await this.simpleInvoice(amount, opts.customerId);
    const { paymentId, allocationId } = await this.paymentWithAllocation(invoiceId, amount);
    const issued = await this.issueCreditNote({
      invoiceId,
      lineId,
      total: amount,
      arReduction: 0,
      advanceExcess: amount,
      release: { sourceKind: 'PAYMENT_ALLOCATION', allocationId, paymentId },
      ...(opts.advanceAccountId ? { advanceAccountId: opts.advanceAccountId } : {}),
    });
    return {
      paymentId,
      advanceId: issued.advanceId!,
      releaseId: issued.releaseId!,
      invoiceId,
      lineId,
    };
  }

  /** an open invoice B (total `total`) of the main customer whose receivable has `amount` of `advanceId`
   *  applied to it — the shape of "cancel B, which was covered by an advance" */
  async invoiceCoveredBy(
    advanceId: string,
    amount: number,
    total: number,
    accountId: string = CCA,
    customerId: string | null = CUSTOMER,
  ): Promise<{ invoiceId: string; lineId: string; applicationId: string }> {
    const inv = await this.simpleInvoice(total, customerId);
    const receivableId = uid();
    await this.pool.query(
      `INSERT INTO customer_receivable (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","invoiceId","creditAuthorized")
       VALUES ($1,$2,$3,$4,$5,'INVOICE',$6,true)`,
      [receivableId, TENANT, COMPANY, BRANCH, accountId, inv.invoiceId],
    );
    const applicationId = uid();
    await this.pool.query(
      `INSERT INTO customer_advance_application (id,"tenantId","companyId","branchId","customerAdvanceId","customerReceivableId","amountMinor","currencyCode","currencyExponent")
       VALUES ($1,$2,$3,$4,$5,$6,$7,'AED',2)`,
      [applicationId, TENANT, COMPANY, BRANCH, advanceId, receivableId, amount],
    );
    return { invoiceId: inv.invoiceId, lineId: inv.lineId, applicationId };
  }

  async freshAccount(): Promise<{ ccaId: string; customerId: string }> {
    const customerId = uid();
    await this.pool.query(
      `INSERT INTO customer (id, "tenantId", "displayName", "updatedAt") VALUES ($1, $2, 'Fresh Customer', now())`,
      [customerId, TENANT],
    );
    const ccaId = uid();
    await this.pool.query(
      `INSERT INTO customer_company_account (id, "tenantId", "companyId", "customerId", "updatedAt")
       VALUES ($1, $2, $3, $4, now())`,
      [ccaId, TENANT, COMPANY, customerId],
    );
    return { ccaId, customerId };
  }

  /** a fresh customer + a CAPTURED invoice-less CUSTOMER_RECEIPT Payment attributed to that customer's account */
  async receiptPayment(
    amount: number,
  ): Promise<{ ccaId: string; customerId: string; paymentId: string }> {
    const { ccaId, customerId } = await this.freshAccount();
    const attemptId = uid();
    await this.pool.query(
      `INSERT INTO payment_attempt
         (id, "tenantId", "companyId", "branchId", "receiptPurpose", "customerCompanyAccountId",
          method, "amountMinor", "currencyCode", "currencyExponent", state, "idempotencyKey", "updatedAt")
       VALUES ($1,$2,$3,$4,'CUSTOMER_RECEIPT',$5,'BANK_TRANSFER',$6,'AED',2,'CAPTURED',$7, now())`,
      [attemptId, TENANT, COMPANY, BRANCH, ccaId, amount, `idem-${attemptId}`],
    );
    const paymentId = uid();
    await this.pool.query(
      `INSERT INTO payment (id, "tenantId", "companyId", "branchId", "sourceAttemptId", method, "amountMinor", "currencyCode", "currencyExponent")
       VALUES ($1,$2,$3,$4,$5,'BANK_TRANSFER',$6,'AED',2)`,
      [paymentId, TENANT, COMPANY, BRANCH, attemptId, amount],
    );
    return { ccaId, customerId, paymentId };
  }

  /** a scope in another BRANCH / COMPANY / TENANT with its own account and branch-scoped credential */
  async foreignScope(kind: Kind): Promise<Foreign> {
    const known = this.foreignMemo.get(kind);
    if (known) return known;
    const p = this.pool;
    let scope: Scope;
    let ccaId = CCA;
    if (kind === 'branch') {
      scope = { tenantId: TENANT, companyId: COMPANY, branchId: uid() };
      await p.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'sibling',now())`,
        [scope.branchId, scope.tenantId, scope.companyId],
      );
    } else {
      const tenantId = kind === 'tenant' ? OTHER_TENANT : TENANT;
      scope = { tenantId, companyId: uid(), branchId: uid() };
      await p.query(
        `INSERT INTO company (id,"tenantId","legalNameEn","defaultCurrency","accountingTimezone","updatedAt") VALUES ($1,$2,'Foreign Co','AED','Asia/Dubai',now())`,
        [scope.companyId, tenantId],
      );
      await p.query(
        `INSERT INTO branch (id,"tenantId","companyId",name,"updatedAt") VALUES ($1,$2,$3,'foreign',now())`,
        [scope.branchId, tenantId, scope.companyId],
      );
      let customerId = CUSTOMER;
      if (kind === 'tenant') {
        customerId = uid();
        await p.query(
          `INSERT INTO customer (id,"tenantId","displayName","updatedAt") VALUES ($1,$2,'Foreign Customer',now())`,
          [customerId, tenantId],
        );
      }
      ccaId = uid();
      await p.query(
        `INSERT INTO customer_company_account (id,"tenantId","companyId","customerId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
        [ccaId, tenantId, scope.companyId, customerId],
      );
    }
    const credId = uid();
    await this.insertCredential(credId, scope);
    const f: Foreign = { ...scope, ccaId, credId };
    this.foreignMemo.set(kind, f);
    return f;
  }

  async chargeOrder(): Promise<string> {
    const id = uid();
    await this.pool.query(
      `INSERT INTO "order"
         (id, "tenantId", "companyId", "originBranchId", "fulfillingBranchId", "customerId", kind, status,
          "currencyCode", "currencyExponent", "commercialSnapshotFingerprint",
          "commercialSnapshotFingerprintVersion", "taxPriceMode", "taxRoundingScope",
          "taxRoundingMode", "documentDiscountAmountMinor", "updatedAt")
       VALUES ($1,$2,$3,$4,$4,$5,'WALK_IN','DRAFT','AED',2,$6,2,'TAX_EXCLUSIVE','LINE','HALF_UP',0,now())`,
      [id, TENANT, COMPANY, BRANCH, CUSTOMER, `fp-${id}`],
    );
    return id;
  }
}

export const chargeStmt = (c: pg.PoolClient, orderId: string, money: Money) => {
  const id = uid();
  return c.query(
    `INSERT INTO cancellation_charge
       (id,"tenantId","companyId","branchId","orderId","cancellationChargeNumber",
        "netAmountMinor","taxAmountMinor","totalAmountMinor","currencyCode","currencyExponent",
        "priceTaxMode","roundingMode","reasonCode","accountingDate")
     VALUES ($1,$2,$3,$4,$5,$6,100,5,105,$7,$8,'TAX_EXCLUSIVE','HALF_UP','CUSTOMER_REQUEST',CURRENT_DATE)`,
    [id, TENANT, COMPANY, BRANCH, orderId, `CC-${id.slice(0, 8)}`, money.code, money.exponent],
  );
};

// ══════════════════════════ the behaviour-case matrix ══════════════════════════════════════════════

export type CaseKind = 'LEGIT' | 'KEEP' | 'DEFECT';
export interface Case {
  key: string;
  kind: CaseKind;
  /** DEFECT: the reason the 49 schema must give; KEEP: the reason the pre-existing guard gives */
  expect?: RegExp;
  /** false for a single statement that can never be committed on its own (a RefundAttempt without its
   *  reservations is always refused by a DEFERRED completeness trigger): "accepted" then means the
   *  STATEMENT itself was accepted. Default true. */
  immediate?: boolean;
  /** seeds whatever the case needs (committed) and returns the statements to attempt */
  build: () => Promise<Run>;
}

const WRONG: { label: string; money: Money }[] = [
  { label: 'currency code', money: USD },
  { label: 'currency exponent', money: AED3 },
];

export function integrityCases(getF: () => Fixtures): Case[] {
  const cases: Case[] = [];
  const add = (c: Case): void => {
    cases.push(c);
  };
  const f = (): Fixtures => getF();

  // ═════════ LEGIT — accepted before and after ═════════
  for (const method of ['BANK_TRANSFER', 'CASH'] as const) {
    add({
      key: `LEGIT local ${method} refund + application (same currency, same customer chain)`,
      kind: 'LEGIT',
      build: async () => {
        const adv = await f().cnAdvance(500);
        return async (c) => {
          const refundId = uid();
          await refundStmt(c, refundId, S0, adv.paymentId, 200, method);
          await applicationStmt(c, S0, adv.advanceId, refundId, 200);
        };
      },
    });
  }
  add({
    key: 'LEGIT provider attempt + reservation (same scope, same currency)',
    kind: 'LEGIT',
    build: async () => {
      const adv = await f().cnAdvance(400);
      return async (c) => {
        const attemptId = uid();
        await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 400);
        await reservationStmt(c, S0, attemptId, adv.releaseId, adv.advanceId, 400);
      };
    },
  });
  add({
    key: 'LEGIT conversion of a PENDING attempt to a SUCCEEDED refund',
    kind: 'LEGIT',
    build: async () => {
      const fx = f();
      const adv = await fx.cnAdvance(400);
      const attemptId = uid();
      const c = await fx.pool.connect();
      try {
        await c.query('BEGIN');
        await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 400);
        await reservationStmt(c, S0, attemptId, adv.releaseId, adv.advanceId, 400);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      return async (cc) => {
        const refundId = uid();
        await cc.query(`SELECT id FROM refund_attempt WHERE id = $1 FOR UPDATE`, [attemptId]);
        await refundStmt(cc, refundId, S0, adv.paymentId, 400, 'ONLINE_GATEWAY', attemptId);
        await applicationStmt(cc, S0, adv.advanceId, refundId, 400);
        await cc.query(
          `UPDATE refund_attempt SET state = 'SUCCEEDED', "resultingRefundId" = $2 WHERE id = $1`,
          [attemptId, refundId],
        );
      };
    },
  });
  add({
    key: 'LEGIT a PENDING attempt can FAIL',
    kind: 'LEGIT',
    build: async () => {
      const fx = f();
      const adv = await fx.cnAdvance(250);
      const attemptId = uid();
      const c = await fx.pool.connect();
      try {
        await c.query('BEGIN');
        await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 250);
        await reservationStmt(c, S0, attemptId, adv.releaseId, adv.advanceId, 250);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      return async (cc) => {
        await cc.query(`UPDATE refund_attempt SET state = 'FAILED' WHERE id = $1`, [attemptId]);
      };
    },
  });
  add({
    key: 'LEGIT event lifecycle: insert RECEIVED, inbox dedup, RECEIVED -> PROCESSED',
    kind: 'LEGIT',
    build: async () => async (c) => {
      const id = uid();
      const providerEventId = `evt-life-${id}`;
      await eventStmt(c, id, S0, CRED, 'RECEIVED', providerEventId);
      const dup = await c.query(
        `INSERT INTO provider_refund_event ("tenantId","companyId","branchId","providerCredentialId","providerEventId","eventType","payloadHash","updatedAt")
         VALUES ($1,$2,$3,$4,$5,'refund.succeeded','hash-m49',now())
         ON CONFLICT ("providerCredentialId","providerEventId") DO NOTHING RETURNING id`,
        [TENANT, COMPANY, BRANCH, CRED, providerEventId],
      );
      if (dup.rowCount !== 0) throw new Error('the inbox dedup inserted a duplicate');
      await c.query(`UPDATE provider_refund_event SET status = 'PROCESSED' WHERE id = $1`, [id]);
    },
  });
  add({
    key: 'LEGIT PAYMENT-sourced advance consumed by a refund of its own Payment',
    kind: 'LEGIT',
    build: async () => {
      const fx = f();
      const r = await fx.receiptPayment(1000);
      const advanceId = uid();
      await fx.pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,500,'AED',2)`,
        [advanceId, TENANT, COMPANY, BRANCH, r.ccaId, r.paymentId],
      );
      return async (c) => {
        const refundId = uid();
        await refundStmt(c, refundId, S0, r.paymentId, 200, 'CASH');
        await applicationStmt(c, S0, advanceId, refundId, 200);
      };
    },
  });
  add({
    key: 'LEGIT credit note: pure AR reduction (invoice, credit note and line share one currency)',
    kind: 'LEGIT',
    build: async () => {
      const inv = await f().simpleInvoice(700);
      return async (c) => {
        await f().issueCreditNoteTx(c, {
          invoiceId: inv.invoiceId,
          lineId: inv.lineId,
          total: 700,
          arReduction: 700,
          advanceExcess: 0,
        });
      };
    },
  });
  add({
    key: "LEGIT credit note funding an advance of the invoice customer's own account (first generation)",
    kind: 'LEGIT',
    build: async () => {
      const fx = f();
      const inv = await fx.simpleInvoice(600);
      const pay = await fx.paymentWithAllocation(inv.invoiceId, 600);
      return async (c) => {
        await fx.issueCreditNoteTx(c, {
          invoiceId: inv.invoiceId,
          lineId: inv.lineId,
          total: 600,
          arReduction: 0,
          advanceExcess: 600,
          release: {
            sourceKind: 'PAYMENT_ALLOCATION',
            allocationId: pay.allocationId,
            paymentId: pay.paymentId,
          },
        });
      };
    },
  });
  add({
    key: 'LEGIT nested chain depth 2: advance A1 -> invoice B -> cancel B -> advance A2 of the same customer (ultimate Payment carried)',
    kind: 'LEGIT',
    build: async () => {
      const fx = f();
      const a1 = await fx.cnAdvance(1000);
      const b = await fx.invoiceCoveredBy(a1.advanceId, 1000, 2000);
      return async (c) => {
        await fx.issueCreditNoteTx(c, {
          invoiceId: b.invoiceId,
          lineId: b.lineId,
          total: 2000,
          arReduction: 1000,
          advanceExcess: 1000,
          release: {
            sourceKind: 'ADVANCE_APPLICATION',
            applicationId: b.applicationId,
            paymentId: a1.paymentId,
          },
        });
      };
    },
  });
  add({
    key: 'LEGIT nested OPENING chain: opening advance -> invoice -> cancel -> advance of the same customer (no Payment)',
    kind: 'LEGIT',
    build: async () => {
      const fx = f();
      const { ccaId, customerId } = await fx.freshAccount();
      const opening = uid();
      await fx.pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
         VALUES ($1,$2,$3,$4,$5,'OPENING',1000,'AED',2,'2026-01-05')`,
        [opening, TENANT, COMPANY, BRANCH, ccaId],
      );
      const b = await fx.invoiceCoveredBy(opening, 1000, 2000, ccaId, customerId);
      return async (c) => {
        await fx.issueCreditNoteTx(c, {
          invoiceId: b.invoiceId,
          lineId: b.lineId,
          total: 2000,
          arReduction: 1000,
          advanceExcess: 1000,
          release: {
            sourceKind: 'OPENING_ADVANCE',
            applicationId: b.applicationId,
            paymentId: null,
          },
        });
      };
    },
  });
  add({
    key: 'LEGIT PAYMENT-sourced advance applied to an invoice, then cancelled: ADVANCE_APPLICATION release with the advance Payment',
    kind: 'LEGIT',
    build: async () => {
      const fx = f();
      const r = await fx.receiptPayment(1000);
      const advanceId = uid();
      await fx.pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,1000,'AED',2)`,
        [advanceId, TENANT, COMPANY, BRANCH, r.ccaId, r.paymentId],
      );
      const b = await fx.invoiceCoveredBy(advanceId, 1000, 2000, r.ccaId, r.customerId);
      return async (c) => {
        await fx.issueCreditNoteTx(c, {
          invoiceId: b.invoiceId,
          lineId: b.lineId,
          total: 2000,
          arReduction: 1000,
          advanceExcess: 1000,
          release: {
            sourceKind: 'ADVANCE_APPLICATION',
            applicationId: b.applicationId,
            paymentId: r.paymentId,
          },
        });
      };
    },
  });
  add({
    key: 'LEGIT cancellation charge in the order and company currency',
    kind: 'LEGIT',
    build: async () => {
      const orderId = await f().chargeOrder();
      return async (c) => {
        await chargeStmt(c, orderId, AED);
      };
    },
  });

  // ═════════ KEEP — pre-existing guards, refused identically before and after ═════════
  for (const kind of KINDS) {
    add({
      key: `KEEP attempt over a ${kind}-foreign credential`,
      kind: 'KEEP',
      expect: /provider_credential .* scope does not match this row's own tenant\/company\/branch/,
      build: async () => {
        const fx = f();
        const foreign = await fx.foreignScope(kind);
        const r = await fx.receiptPayment(1000);
        return async (c) => {
          await attemptStmt(c, uid(), S0, r.paymentId, foreign.credId, 400);
        };
      },
    });
    add({
      key: `KEEP reservation stamped with a ${kind}-foreign scope`,
      kind: 'KEEP',
      expect: /scope mismatch against the parent refund_attempt/,
      build: async () => {
        const fx = f();
        const foreign = await fx.foreignScope(kind);
        const adv = await fx.cnAdvance(400);
        return async (c) => {
          const attemptId = uid();
          await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 400);
          await reservationStmt(c, foreign, attemptId, adv.releaseId, adv.advanceId, 400);
        };
      },
    });
  }
  add({
    key: 'KEEP no cross-advance reservation',
    kind: 'KEEP',
    expect: /frozen 1:1 release\/advance pair/,
    build: async () => {
      const a1 = await f().cnAdvance(400);
      const a2 = await f().cnAdvance(400);
      return async (c) => {
        const attemptId = uid();
        await attemptStmt(c, attemptId, S0, a1.paymentId, CRED, 400);
        await reservationStmt(c, S0, attemptId, a1.releaseId, a2.advanceId, 400);
      };
    },
  });
  add({
    key: 'KEEP reservation currency differs from its funding release',
    kind: 'KEEP',
    expect: /currency mismatch against the funding release/,
    build: async () => {
      const adv = await f().cnAdvance(400);
      return async (c) => {
        const attemptId = uid();
        await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 400);
        await reservationStmt(c, S0, attemptId, adv.releaseId, adv.advanceId, 400, USD);
      };
    },
  });
  add({
    key: 'KEEP release provenance: a PAYMENT-sourced advance application released with a WRONG Payment',
    kind: 'KEEP',
    expect:
      /sourcePaymentId does not match the underlying PAYMENT-sourced customer_advance's own sourcePaymentId/,
    build: async () => {
      const fx = f();
      const r = await fx.receiptPayment(1000);
      const other = await fx.receiptPayment(1000);
      const advanceId = uid();
      await fx.pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","sourcePaymentId","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'PAYMENT',$6,1000,'AED',2)`,
        [advanceId, TENANT, COMPANY, BRANCH, r.ccaId, r.paymentId],
      );
      const b = await fx.invoiceCoveredBy(advanceId, 1000, 2000, r.ccaId, r.customerId);
      return async (c) => {
        await fx.issueCreditNoteTx(c, {
          invoiceId: b.invoiceId,
          lineId: b.lineId,
          total: 2000,
          arReduction: 1000,
          advanceExcess: 1000,
          release: {
            sourceKind: 'ADVANCE_APPLICATION',
            applicationId: b.applicationId,
            paymentId: other.paymentId,
          },
        });
      };
    },
  });
  add({
    key: 'KEEP release provenance: a nested chain released with a WRONG ultimate Payment',
    kind: 'KEEP',
    expect: /does not match the ultimate Payment provenance carried by the funding release/,
    build: async () => {
      const fx = f();
      const a1 = await fx.cnAdvance(1000);
      const other = await fx.receiptPayment(1000);
      const b = await fx.invoiceCoveredBy(a1.advanceId, 1000, 2000);
      return async (c) => {
        await fx.issueCreditNoteTx(c, {
          invoiceId: b.invoiceId,
          lineId: b.lineId,
          total: 2000,
          arReduction: 1000,
          advanceExcess: 1000,
          release: {
            sourceKind: 'ADVANCE_APPLICATION',
            applicationId: b.applicationId,
            paymentId: other.paymentId,
          },
        });
      };
    },
  });
  add({
    key: 'KEEP release provenance: an OPENING chain released as ADVANCE_APPLICATION',
    kind: 'KEEP',
    expect:
      /requires a Payment-traced provenance|requires the underlying customer_advance to be sourceType=PAYMENT/,
    build: async () => {
      const fx = f();
      const { ccaId, customerId } = await fx.freshAccount();
      const opening = uid();
      await fx.pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent","openingEffectiveDate")
         VALUES ($1,$2,$3,$4,$5,'OPENING',1000,'AED',2,'2026-01-05')`,
        [opening, TENANT, COMPANY, BRANCH, ccaId],
      );
      const other = await fx.receiptPayment(1000);
      const b = await fx.invoiceCoveredBy(opening, 1000, 2000, ccaId, customerId);
      return async (c) => {
        await fx.issueCreditNoteTx(c, {
          invoiceId: b.invoiceId,
          lineId: b.lineId,
          total: 2000,
          arReduction: 1000,
          advanceExcess: 1000,
          release: {
            sourceKind: 'ADVANCE_APPLICATION',
            applicationId: b.applicationId,
            paymentId: other.paymentId,
          },
        });
      };
    },
  });
  add({
    key: "KEEP release provenance: another invoice's allocation used as false provenance",
    kind: 'KEEP',
    expect: /payment_allocation .* own invoiceId does not match credit_note .* own invoiceId/,
    build: async () => {
      const fx = f();
      const target = await fx.simpleInvoice(500);
      const otherInvoice = await fx.simpleInvoice(500);
      const otherPay = await fx.paymentWithAllocation(otherInvoice.invoiceId, 500);
      return async (c) => {
        await fx.issueCreditNoteTx(c, {
          invoiceId: target.invoiceId,
          lineId: target.lineId,
          total: 500,
          arReduction: 0,
          advanceExcess: 500,
          release: {
            sourceKind: 'PAYMENT_ALLOCATION',
            allocationId: otherPay.allocationId,
            paymentId: otherPay.paymentId,
          },
        });
      };
    },
  });
  add({
    key: 'KEEP release provenance: a nested release whose funding release is MISSING (malformed lineage)',
    kind: 'KEEP',
    expect: /has 0 funding credit_note_coverage_release rows/,
    build: async () => {
      const fx = f();
      const orphan = uid();
      await fx.pool.query(
        `INSERT INTO customer_advance (id,"tenantId","companyId","branchId","customerCompanyAccountId","sourceType","amountMinor","currencyCode","currencyExponent")
         VALUES ($1,$2,$3,$4,$5,'CREDIT_NOTE',1000,'AED',2)`,
        [orphan, TENANT, COMPANY, BRANCH, CCA],
      );
      const other = await fx.receiptPayment(1000);
      const b = await fx.invoiceCoveredBy(orphan, 1000, 2000);
      return async (c) => {
        await fx.issueCreditNoteTx(c, {
          invoiceId: b.invoiceId,
          lineId: b.lineId,
          total: 2000,
          arReduction: 1000,
          advanceExcess: 1000,
          release: {
            sourceKind: 'ADVANCE_APPLICATION',
            applicationId: b.applicationId,
            paymentId: other.paymentId,
          },
        });
      };
    },
  });

  // ═════════ DEFECT O-1 — currency authority (accepted by the 48 schema, refused by the 49 schema) ═════════
  for (const w of WRONG) {
    add({
      key: `DEFECT O-1 refund over a Payment of another ${w.label}`,
      kind: 'DEFECT',
      expect: /currency .* does not match sourcePayment/,
      build: async () => {
        const adv = await f().cnAdvance(300);
        return async (c) => {
          const refundId = uid();
          await refundStmt(c, refundId, S0, adv.paymentId, 300, 'BANK_TRANSFER', null, w.money);
          await applicationStmt(c, S0, adv.advanceId, refundId, 300, w.money);
        };
      },
    });
    add({
      key: `DEFECT O-1 attempt over a Payment of another ${w.label}`,
      kind: 'DEFECT',
      immediate: false,
      expect: /currency .* does not match sourcePayment/,
      build: async () => {
        const r = await f().receiptPayment(1000);
        return async (c) => {
          await attemptStmt(c, uid(), S0, r.paymentId, CRED, 400, w.money);
        };
      },
    });
    add({
      key: `DEFECT O-1 credit note over an invoice of another ${w.label}`,
      kind: 'DEFECT',
      expect: /currency .* does not match invoice/,
      build: async () => {
        const inv = await f().simpleInvoice(500);
        return async (c) => {
          await f().issueCreditNoteTx(c, {
            invoiceId: inv.invoiceId,
            lineId: inv.lineId,
            total: 500,
            arReduction: 500,
            advanceExcess: 0,
            cnCurrency: w.money,
          });
        };
      },
    });
    add({
      key: `DEFECT O-1 credit note line of another ${w.label} than its credit note`,
      kind: 'DEFECT',
      expect: /currency .* does not match credit_note/,
      build: async () => {
        const inv = await f().simpleInvoice(500);
        return async (c) => {
          await f().issueCreditNoteTx(c, {
            invoiceId: inv.invoiceId,
            lineId: inv.lineId,
            total: 500,
            arReduction: 500,
            advanceExcess: 0,
            lineCurrency: w.money,
          });
        };
      },
    });
    add({
      key: `DEFECT O-1 cancellation charge over an order of another ${w.label}`,
      kind: 'DEFECT',
      expect: /currency .* does not match order/,
      build: async () => {
        const orderId = await f().chargeOrder();
        return async (c) => {
          await chargeStmt(c, orderId, w.money);
        };
      },
    });
    add({
      key: `DEFECT O-1 application of another ${w.label} than its refund and advance`,
      kind: 'DEFECT',
      expect: /currency .* does not match refund/,
      build: async () => {
        const adv = await f().cnAdvance(300);
        return async (c) => {
          const refundId = uid();
          await refundStmt(c, refundId, S0, adv.paymentId, 300);
          await applicationStmt(c, S0, adv.advanceId, refundId, 300, w.money);
        };
      },
    });
  }
  // The forged-parent cases: one parent row's currency pair is forged (triggers off for that single statement) so
  // that the child agrees with EVERY parent but one — each guard is then pinned on its own, for the code AND for
  // the exponent half of its (code, exponent) pair (a 3-decimal currency mislabelled as 2-decimal is a 10x error).
  for (const w of WRONG) {
    add({
      key: `DEFECT O-1 refund that matches its Payment but not the Company's ${w.label}`,
      kind: 'DEFECT',
      expect: /currency .* does not match company/,
      build: async () => {
        const adv = await f().cnAdvance(300);
        return async (c) => {
          await forgeMoney(c, 'payment', adv.paymentId, w.money);
          const refundId = uid();
          await refundStmt(c, refundId, S0, adv.paymentId, 300, 'BANK_TRANSFER', null, w.money);
          await applicationStmt(c, S0, adv.advanceId, refundId, 300, w.money);
        };
      },
    });
    add({
      key: `DEFECT O-1 attempt that matches its Payment but not the Company's ${w.label}`,
      kind: 'DEFECT',
      immediate: false,
      expect: /currency .* does not match company/,
      build: async () => {
        const r = await f().receiptPayment(1000);
        return async (c) => {
          await forgeMoney(c, 'payment', r.paymentId, w.money);
          await attemptStmt(c, uid(), S0, r.paymentId, CRED, 400, w.money);
        };
      },
    });
    add({
      key: `DEFECT O-1 application that matches its refund and advance but not the Company's ${w.label}`,
      kind: 'DEFECT',
      expect: /currency .* does not match company/,
      build: async () => {
        const adv = await f().cnAdvance(300);
        return async (c) => {
          const refundId = uid();
          await refundStmt(c, refundId, S0, adv.paymentId, 300);
          // both parents are forged, so the application agrees with EACH of them: only the Company is left
          await forgeMoney(c, 'refund', refundId, w.money);
          await forgeMoney(c, 'customer_advance', adv.advanceId, w.money);
          await applicationStmt(c, S0, adv.advanceId, refundId, 300, w.money);
        };
      },
    });
    add({
      key: `DEFECT O-1 reservation that matches its attempt, advance and funding release but not the Company's ${w.label}`,
      kind: 'DEFECT',
      expect: /currency .* does not match company/,
      build: async () => {
        const adv = await f().cnAdvance(400);
        return async (c) => {
          const attemptId = uid();
          await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 400);
          // attempt, advance and the funding release are all forged: only the Company is left
          await forgeMoney(c, 'refund_attempt', attemptId, w.money);
          await forgeMoney(c, 'customer_advance', adv.advanceId, w.money);
          await forgeMoney(c, 'credit_note_coverage_release', adv.releaseId, w.money);
          await reservationStmt(c, S0, attemptId, adv.releaseId, adv.advanceId, 400, w.money);
        };
      },
    });
    add({
      key: `DEFECT O-1 conversion refund whose ${w.label} differs from its attempt's`,
      kind: 'DEFECT',
      expect: /currency .* does not match refund_attempt/,
      build: async () => {
        const fx = f();
        const adv = await fx.cnAdvance(400);
        const attemptId = uid();
        const c0 = await fx.pool.connect();
        try {
          await c0.query('BEGIN');
          await attemptStmt(c0, attemptId, S0, adv.paymentId, CRED, 400);
          await reservationStmt(c0, S0, attemptId, adv.releaseId, adv.advanceId, 400);
          await c0.query('COMMIT');
        } finally {
          c0.release();
        }
        return async (c) => {
          await forgeMoney(c, 'refund_attempt', attemptId, w.money);
          const refundId = uid();
          await refundStmt(c, refundId, S0, adv.paymentId, 400, 'ONLINE_GATEWAY', attemptId);
          await applicationStmt(c, S0, adv.advanceId, refundId, 400);
        };
      },
    });
    add({
      key: `DEFECT O-1 application whose refund's ${w.label} was forged away from the advance's`,
      kind: 'DEFECT',
      expect: /currency .* does not match refund/,
      build: async () => {
        const adv = await f().cnAdvance(300);
        return async (c) => {
          const refundId = uid();
          await refundStmt(c, refundId, S0, adv.paymentId, 300);
          await forgeMoney(c, 'refund', refundId, w.money);
          await applicationStmt(c, S0, adv.advanceId, refundId, 300);
        };
      },
    });
    add({
      key: `DEFECT O-1 refund vs CustomerAdvance ${w.label} mismatch (the advance row is forged)`,
      kind: 'DEFECT',
      expect: /currency .* does not match customerAdvance/,
      build: async () => {
        const adv = await f().cnAdvance(300);
        return async (c) => {
          await forgeMoney(c, 'customer_advance', adv.advanceId, w.money);
          const refundId = uid();
          await refundStmt(c, refundId, S0, adv.paymentId, 300);
          await applicationStmt(c, S0, adv.advanceId, refundId, 300);
        };
      },
    });
    add({
      key: `DEFECT O-1 reservation whose attempt's ${w.label} was forged away from the advance's`,
      kind: 'DEFECT',
      expect: /currency .* does not match refund_attempt/,
      build: async () => {
        const adv = await f().cnAdvance(400);
        return async (c) => {
          const attemptId = uid();
          await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 400);
          await forgeMoney(c, 'refund_attempt', attemptId, w.money);
          await reservationStmt(c, S0, attemptId, adv.releaseId, adv.advanceId, 400);
        };
      },
    });
    add({
      key: `DEFECT O-1 reservation vs CustomerAdvance ${w.label} mismatch (the advance row is forged)`,
      kind: 'DEFECT',
      expect: /currency .* does not match customerAdvance/,
      build: async () => {
        const adv = await f().cnAdvance(400);
        return async (c) => {
          await forgeMoney(c, 'customer_advance', adv.advanceId, w.money);
          const attemptId = uid();
          await attemptStmt(c, attemptId, S0, adv.paymentId, CRED, 400);
          await reservationStmt(c, S0, attemptId, adv.releaseId, adv.advanceId, 400);
        };
      },
    });
    add({
      key: `DEFECT O-1 credit note that matches its invoice but not the Company's ${w.label}`,
      kind: 'DEFECT',
      expect: /currency .* does not match company/,
      build: async () => {
        const inv = await f().simpleInvoice(500);
        return async (c) => {
          await forgeMoney(c, 'invoice', inv.invoiceId, w.money);
          await f().issueCreditNoteTx(c, {
            invoiceId: inv.invoiceId,
            lineId: inv.lineId,
            total: 500,
            arReduction: 500,
            advanceExcess: 0,
            cnCurrency: w.money,
          });
        };
      },
    });
    add({
      key: `DEFECT O-1 cancellation charge that matches its order but not the Company's ${w.label}`,
      kind: 'DEFECT',
      expect: /currency .* does not match company/,
      build: async () => {
        const orderId = await f().chargeOrder();
        return async (c) => {
          await forgeMoney(c, '"order"', orderId, w.money);
          await chargeStmt(c, orderId, w.money);
        };
      },
    });
  }

  // ═════════ DEFECT O-2A — coverage-release scope ═════════
  for (const kind of KINDS) {
    const column = { branch: '"branchId"', company: '"companyId"', tenant: '"tenantId"' }[kind];
    const valueOf = (fo: Foreign): string =>
      ({ branch: fo.branchId, company: fo.companyId, tenant: fo.tenantId })[kind];
    add({
      key: `DEFECT O-2A release stamped with a ${kind}-foreign scope over a main-scope credit note and advance`,
      kind: 'DEFECT',
      expect: /scope does not match credit_note/,
      build: async () => {
        const fx = f();
        const fo = await fx.foreignScope(kind);
        const inv = await fx.simpleInvoice(500);
        const pay = await fx.paymentWithAllocation(inv.invoiceId, 500);
        return async (c) => {
          await fx.issueCreditNoteTx(c, {
            invoiceId: inv.invoiceId,
            lineId: inv.lineId,
            total: 500,
            arReduction: 0,
            advanceExcess: 500,
            release: {
              sourceKind: 'PAYMENT_ALLOCATION',
              allocationId: pay.allocationId,
              paymentId: pay.paymentId,
            },
            releaseScope: fo,
          });
        };
      },
    });
    add({
      key: `DEFECT O-2A release whose CustomerAdvance parent sits in a ${kind}-foreign scope`,
      kind: 'DEFECT',
      expect: /scope does not match customer_advance/,
      build: async () => {
        const fx = f();
        const fo = await fx.foreignScope(kind);
        const inv = await fx.simpleInvoice(500);
        const pay = await fx.paymentWithAllocation(inv.invoiceId, 500);
        return async (c) => {
          await fx.issueCreditNoteTx(c, {
            invoiceId: inv.invoiceId,
            lineId: inv.lineId,
            total: 500,
            arReduction: 0,
            advanceExcess: 500,
            release: {
              sourceKind: 'PAYMENT_ALLOCATION',
              allocationId: pay.allocationId,
              paymentId: pay.paymentId,
            },
            beforeRelease: async (cc, ids) => {
              await forge(cc, `UPDATE customer_advance SET ${column} = $2 WHERE id = $1`, [
                ids.advanceId,
                valueOf(fo),
              ]);
            },
          });
        };
      },
    });
    add({
      key: `DEFECT O-2A release whose CreditNote parent sits in a ${kind}-foreign scope`,
      kind: 'DEFECT',
      expect: /scope does not match credit_note/,
      build: async () => {
        const fx = f();
        const fo = await fx.foreignScope(kind);
        const inv = await fx.simpleInvoice(500);
        const pay = await fx.paymentWithAllocation(inv.invoiceId, 500);
        return async (c) => {
          await fx.issueCreditNoteTx(c, {
            invoiceId: inv.invoiceId,
            lineId: inv.lineId,
            total: 500,
            arReduction: 0,
            advanceExcess: 500,
            release: {
              sourceKind: 'PAYMENT_ALLOCATION',
              allocationId: pay.allocationId,
              paymentId: pay.paymentId,
            },
            beforeRelease: async (cc, ids) => {
              await forge(cc, `UPDATE credit_note SET ${column} = $2 WHERE id = $1`, [
                ids.cnId,
                valueOf(fo),
              ]);
            },
          });
        };
      },
    });
  }

  // ═════════ DEFECT O-2B — CREDIT_NOTE advance customer attribution ═════════
  add({
    key: "DEFECT O-2B same tenant/company/branch, but the advance belongs to ANOTHER customer's account",
    kind: 'DEFECT',
    expect: /belongs to a different customer than credit_note/,
    build: async () => {
      const fx = f();
      const other = await fx.freshAccount();
      const inv = await fx.simpleInvoice(500);
      const pay = await fx.paymentWithAllocation(inv.invoiceId, 500);
      return async (c) => {
        await fx.issueCreditNoteTx(c, {
          invoiceId: inv.invoiceId,
          lineId: inv.lineId,
          total: 500,
          arReduction: 0,
          advanceExcess: 500,
          release: {
            sourceKind: 'PAYMENT_ALLOCATION',
            allocationId: pay.allocationId,
            paymentId: pay.paymentId,
          },
          advanceAccountId: other.ccaId,
        });
      };
    },
  });
  add({
    key: "DEFECT O-2B a nested CREDIT_NOTE chain whose new advance belongs to ANOTHER customer's account",
    kind: 'DEFECT',
    expect: /belongs to a different customer than credit_note/,
    build: async () => {
      const fx = f();
      const other = await fx.freshAccount();
      const a1 = await fx.cnAdvance(1000);
      const b = await fx.invoiceCoveredBy(a1.advanceId, 1000, 2000);
      return async (c) => {
        await fx.issueCreditNoteTx(c, {
          invoiceId: b.invoiceId,
          lineId: b.lineId,
          total: 2000,
          arReduction: 1000,
          advanceExcess: 1000,
          release: {
            sourceKind: 'ADVANCE_APPLICATION',
            applicationId: b.applicationId,
            paymentId: a1.paymentId,
          },
          advanceAccountId: other.ccaId,
        });
      };
    },
  });
  add({
    key: 'DEFECT O-2B an advance whose customer ACCOUNT lives in another company (the account link is forged)',
    kind: 'DEFECT',
    expect: /customer account .* is not in this tenant\/company/,
    build: async () => {
      const fx = f();
      const fo = await fx.foreignScope('company');
      const inv = await fx.simpleInvoice(500);
      const pay = await fx.paymentWithAllocation(inv.invoiceId, 500);
      return async (c) => {
        await fx.issueCreditNoteTx(c, {
          invoiceId: inv.invoiceId,
          lineId: inv.lineId,
          total: 500,
          arReduction: 0,
          advanceExcess: 500,
          release: {
            sourceKind: 'PAYMENT_ALLOCATION',
            allocationId: pay.allocationId,
            paymentId: pay.paymentId,
          },
          beforeRelease: async (cc, ids) => {
            await forge(
              cc,
              `UPDATE customer_advance SET "customerCompanyAccountId" = $2 WHERE id = $1`,
              [ids.advanceId, fo.ccaId],
            );
          },
        });
      };
    },
  });
  add({
    key: 'DEFECT O-2B a walk-in (customer-less) invoice can never fund a customer advance',
    kind: 'DEFECT',
    expect: /has no customer \(walk-in\)/,
    build: async () => {
      const fx = f();
      const inv = await fx.simpleInvoice(500, null);
      const pay = await fx.paymentWithAllocation(inv.invoiceId, 500);
      return async (c) => {
        await fx.issueCreditNoteTx(c, {
          invoiceId: inv.invoiceId,
          lineId: inv.lineId,
          total: 500,
          arReduction: 0,
          advanceExcess: 500,
          release: {
            sourceKind: 'PAYMENT_ALLOCATION',
            allocationId: pay.allocationId,
            paymentId: pay.paymentId,
          },
        });
      };
    },
  });

  return cases;
}

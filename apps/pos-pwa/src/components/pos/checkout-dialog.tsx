'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type {
  OrderTotalsPreview,
  PosCustomerAccountSummary,
  PosCustomerRow,
  PosOrderLineRow,
} from '@flower/api-client';
import { authed, describeError, newKey } from '@/lib/api';
import { cartFingerprint, toOrderLines, type Cart } from '@/lib/cart';
import {
  checkoutErrorMessage,
  completeKeyForSale,
  orderStep,
  withOrder,
  withSale,
  type CheckoutAttempt,
} from '@/lib/checkout';
import type { PosContext } from '@/lib/context';
import {
  CREDIT_REFUSAL_TEXT,
  availableAdvances,
  creditAdvisory,
  planCustomerPayment,
  type AdvanceChoice,
  type SettleMode,
} from '@/lib/credit-plan';
import { formatMinor, parseAmountInput } from '@/lib/money-display';
import { buildReceipt, type ReceiptModel, type ReceiptSeller } from '@/lib/receipt';
import { changeAid, quickCashAmounts, type ChangeAid } from '@/lib/tender';
import { unclassifiedLabels, vatBlockMessage } from '@/lib/tax-guard';
import { ReceiptView } from './receipt-view';

/**
 * CHECKOUT: create (or update) the draft order from the cart, show the SERVER's totals incl. VAT, take the payment, complete the sale, show the
 * receipt. The checkout attempt (idempotency keys, draft order id) is owned by the parent and survives closing and re-opening this dialog, so a
 * retry after a timeout replays the same operation instead of selling twice.
 *
 * CUSTOMER SALES (frozen `complete-sale` contract): with an identified customer the cashier can also spend the customer's ADVANCES and sell ON
 * CREDIT (the unpaid remainder becomes the customer's receivable). Every rule — the credit limit, advance availability, who may apply an advance
 * or grant a credit exception — is the SERVER's; this dialog only builds the request, previews the arithmetic, and shows the server's refusals.
 */

interface AccountState {
  summary: PosCustomerAccountSummary | null;
  advances: AdvanceChoice[];
  /** why the account could not be shown (never blocks the sale: the server still decides) */
  note: string | null;
}

export function CheckoutDialog({
  cart,
  customer,
  context,
  seller,
  attemptRef,
  onSold,
  onNewSale,
  onClose,
}: {
  cart: Cart;
  customer: PosCustomerRow | null;
  context: PosContext;
  seller: ReceiptSeller;
  attemptRef: MutableRefObject<CheckoutAttempt>;
  /** called once the sale is recorded (the cart can be cleared) */
  onSold: () => void;
  onNewSale: () => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<'preparing' | 'pay' | 'paying' | 'done'>('preparing');
  const [totals, setTotals] = useState<OrderTotalsPreview | null>(null);
  const [mode, setMode] = useState<SettleMode>('CASH');
  const [cashText, setCashText] = useState('');
  const [cardText, setCardText] = useState('');
  const [depositText, setDepositText] = useState('');
  const [depositMethod, setDepositMethod] = useState<'CASH' | 'CARD'>('CASH');
  const [reason, setReason] = useState('');
  const [needException, setNeedException] = useState(false);
  const [needStepUp, setNeedStepUp] = useState(false);
  const [stepUpCode, setStepUpCode] = useState('');
  const [account, setAccount] = useState<AccountState | null>(null);
  const [advanceText, setAdvanceText] = useState<Record<string, string>>({});
  const [accountAfter, setAccountAfter] = useState<PosCustomerAccountSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReceiptModel | null>(null);
  const [aid, setAid] = useState<ChangeAid | null>(null);
  // F-6: lines the server priced with no VAT category — payment is refused at the till until the owner classifies them
  const [vatBlock, setVatBlock] = useState<string | null>(null);
  const startedRef = useRef(false);

  const readAccount = useCallback(async (): Promise<AccountState> => {
    if (!customer) return { summary: null, advances: [], note: null };
    try {
      const [summary, page] = await Promise.all([
        authed((a) =>
          a.getCustomerAccountSummary(context.companyId, context.branchId, customer.id),
        ),
        authed((a) =>
          a.listCustomerAdvances(context.companyId, context.branchId, customer.id, { limit: 50 }),
        ),
      ]);
      return { summary, advances: availableAdvances(page.data), note: null };
    } catch (err) {
      const d = describeError(err);
      return {
        summary: null,
        advances: [],
        note:
          d.status === 403
            ? 'The customer’s account (balance, advances, credit) is not available to you. The sale can still be taken; the system checks credit and advances itself.'
            : 'The customer’s account could not be read. The sale can still be taken; the system checks credit and advances itself.',
      };
    }
  }, [customer, context]);

  const prepare = useCallback(async (): Promise<void> => {
    setPhase('preparing');
    setError(null);
    try {
      const fp = cartFingerprint(cart, customer?.id ?? null);
      let attempt = attemptRef.current;
      const step = orderStep(attempt, fp);
      if (step === 'FINISHED') return;
      if (step === 'CREATE') {
        const res = await authed((a) =>
          a.createOrder(
            context.companyId,
            context.branchId,
            { ...(customer ? { customerId: customer.id } : {}), lines: toOrderLines(cart) },
            attempt.createKey,
          ),
        );
        attempt = withOrder(attempt, res.order, fp);
      } else if (step === 'UPDATE') {
        const res = await authed((a) =>
          a.updateOrder(
            context.companyId,
            context.branchId,
            attempt.orderId!,
            { customerId: customer?.id ?? null, lines: toOrderLines(cart) },
            attempt.orderVersion!,
          ),
        );
        attempt = withOrder(attempt, res.order, fp);
      }
      const t = await authed((a) =>
        a.getOrderTotals(context.companyId, context.branchId, attempt.orderId!),
      );
      attempt = { ...attempt, orderVersion: t.version };
      attemptRef.current = attempt;
      // fail closed: if the priced lines cannot be read, the VAT classification cannot be verified either
      const priced = await authed((a) =>
        a.getOrder(context.companyId, context.branchId, attempt.orderId!),
      );
      const missing = unclassifiedLabels(priced.lines);
      setVatBlock(missing.length > 0 ? vatBlockMessage(missing) : null);
      setTotals(t);
      setPhase('pay');
      // the customer's account (balance, advances, credit) — read separately: it never blocks a sale
      void readAccount().then(setAccount);
    } catch (err) {
      const d = describeError(err);
      setError(`${checkoutErrorMessage(d.code, d.status)} (${d.code})`);
      setPhase('pay');
    }
  }, [cart, customer, context, attemptRef, readAccount]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void prepare();
  }, [prepare]);

  const exponent = totals?.currencyExponent ?? 2;
  const totalMinor = totals ? BigInt(totals.totalAmountMinor) : 0n;
  const amount = (text: string): bigint | null | undefined =>
    text.trim() === '' ? null : (parseAmountInput(text, exponent) ?? undefined);

  // the advances the cashier chose to spend: blank = none, an unreadable amount = -1 (the plan refuses it)
  const advanceChoices = useMemo<AdvanceChoice[]>(
    () =>
      (account?.advances ?? []).map((a) => {
        const v = amount(advanceText[a.advanceId] ?? '');
        return { ...a, applyMinor: v === null ? 0n : v === undefined ? -1n : v };
      }),
    [account, advanceText, exponent],
  );

  const plan = useMemo(() => {
    const cash = amount(cashText);
    const card = amount(cardText);
    const deposit = amount(depositText);
    return planCustomerPayment({
      totalMinor,
      hasCustomer: customer !== null,
      advances: advanceChoices,
      mode,
      cashTenderedMinor: cash ?? null,
      cardMinor: card ?? null,
      depositMinor: deposit === undefined ? -1n : deposit,
      depositMethod,
      creditReason: needException ? reason : null,
    });
  }, [
    totalMinor,
    customer,
    advanceChoices,
    mode,
    cashText,
    cardText,
    depositText,
    depositMethod,
    reason,
    needException,
    exponent,
  ]);

  const advanceSum = advanceChoices.reduce(
    (s, a) => (a.applyMinor > 0n ? s + a.applyMinor : s),
    0n,
  );
  const creditPreview = plan.ok ? plan.figures.creditMinor : 0n;
  const advisory =
    mode === 'CREDIT' ? creditAdvisory(account?.summary ?? null, creditPreview) : null;

  function useAdvance(a: AdvanceChoice): void {
    const others = advanceChoices
      .filter((x) => x.advanceId !== a.advanceId && x.applyMinor > 0n)
      .reduce((s, x) => s + x.applyMinor, 0n);
    const room = totalMinor - others;
    const take = room <= 0n ? 0n : a.availableMinor < room ? a.availableMinor : room;
    setAdvanceText({
      ...advanceText,
      [a.advanceId]: take > 0n ? formatMinor(take, exponent).replace(/,/g, '') : '',
    });
  }

  async function pay(): Promise<void> {
    if (!totals || !plan.ok || vatBlock) return;
    setPhase('paying');
    setError(null);
    setNeedStepUp(false);
    const request = plan.request;
    try {
      const { attempt: keyed, key } = completeKeyForSale(attemptRef.current, request, newKey);
      attemptRef.current = keyed;
      const sale = await authed((a) =>
        a.completeSale(
          context.companyId,
          context.branchId,
          keyed.orderId!,
          request,
          keyed.orderVersion!,
          key,
        ),
      );
      attemptRef.current = withSale(attemptRef.current, sale);
      onSold();
      // the receipt is built from what the SERVER recorded: the invoice, the order lines (name / price / VAT snapshots), the payments, the
      // advances applied and the amount left outstanding on the customer's account
      let lines: PosOrderLineRow[] = [];
      let invoiceDate = new Date().toISOString().slice(0, 10); // fallback only; the server's invoice date is used when it can be read
      try {
        const full = await authed((a) =>
          a.getOrder(context.companyId, context.branchId, sale.order.id),
        );
        lines = full.lines;
        if (full.issuedInvoice?.invoiceDate) invoiceDate = full.issuedInvoice.invoiceDate;
      } catch {
        /* the sale is recorded; a receipt without lines can be reprinted from the sales list */
      }
      setReceipt(
        buildReceipt({
          seller,
          branchName: context.branchName,
          orderNumber: sale.order.orderNumber,
          invoice: {
            invoiceNumber: sale.invoice.invoiceNumber,
            invoiceDate,
            currencyCode: sale.invoice.currencyCode,
            currencyExponent: sale.invoice.currencyExponent,
            subtotalAmountMinor: sale.invoice.subtotalAmountMinor,
            documentDiscountAmountMinor: sale.invoice.documentDiscountAmountMinor,
            taxTotalAmountMinor: sale.invoice.taxTotalAmountMinor,
            totalAmountMinor: sale.invoice.totalAmountMinor,
            paymentStatus: sale.invoice.paymentStatus,
          },
          lines,
          priceTaxMode: totals.priceTaxMode,
          customerName: customer?.displayName ?? null,
          payments: sale.payments.map((p) => ({ method: p.method, amountMinor: p.amountMinor })),
          advances: sale.advanceApplications.map((a) => ({ amountMinor: a.amountMinor })),
          outstandingMinor: sale.outstandingMinor,
          copy: 'ORIGINAL',
        }),
      );
      // on-screen counting aid only — what was handed over and the change are NOT recorded and NOT printed
      setAid(
        plan.cashDueMinor > 0n && plan.changeDueMinor > 0n && mode !== 'CREDIT'
          ? changeAid(
              {
                ok: true,
                tenders: [],
                cashDueMinor: plan.cashDueMinor,
                cardMinor: 0n,
                changeDueMinor: plan.changeDueMinor,
              },
              parseAmountInput(cashText, exponent) ?? null,
              exponent,
            )
          : null,
      );
      setPhase('done');
      // the customer's account AFTER this sale (balance owed, advances left) — what the cashier can tell the customer
      if (customer) void readAccount().then((s) => setAccountAfter(s.summary));
    } catch (err) {
      const d = describeError(err);
      if (d.code === 'CUSTOMER_CREDIT_LIMIT_EXCEEDED') setNeedException(true);
      if (d.code === 'STEP_UP_REQUIRED') setNeedStepUp(true);
      setError(
        d.status === 0
          ? 'Connection problem — the sale may or may not have been recorded. Press Confirm again to retry safely (the same payment is never taken twice), or check the sales list before handing over the goods.'
          : `${checkoutErrorMessage(d.code, d.status, {
              usedAdvance: (request.advanceApplications?.length ?? 0) > 0,
              usedCredit: request.paymentIntent === 'ON_CREDIT',
            })} (${d.code})`,
      );
      setPhase('pay');
    }
  }

  async function verifyStepUp(): Promise<void> {
    try {
      await authed((a) => a.stepUp(stepUpCode.trim()));
      setNeedStepUp(false);
      setStepUpCode('');
      setError('Verified. Press Confirm again to complete the sale.');
    } catch (err) {
      const d = describeError(err);
      setError(`${checkoutErrorMessage(d.code, d.status)} (${d.code})`);
    }
  }

  if (phase === 'done' && receipt) {
    const owes = accountAfter
      ? BigInt(accountAfter.branchFinancials.receivableOutstandingMinor)
      : null;
    const adv = accountAfter ? BigInt(accountAfter.branchFinancials.advanceAvailableMinor) : null;
    return (
      <div className="modal" role="dialog" aria-modal="true" aria-label="Sale complete">
        <div className="modal__panel modal__panel--receipt">
          <p className="success" data-testid="sale-complete">
            Sale recorded ✓
          </p>
          {aid ? (
            <div className="change-aid no-print" data-testid="change-aid" role="status">
              <p>
                Hand the customer back <strong data-testid="aid-change">{aid.change}</strong>
              </p>
              <p className="muted">
                They gave {aid.handedOver}. The sale is recorded as cash {aid.recordedCash} (the
                amount that stays in the till). The cash handed over and the change are NOT recorded
                by the system and are not on the invoice.
              </p>
            </div>
          ) : null}
          {owes !== null && adv !== null && customer ? (
            <p className="muted no-print" data-testid="account-after">
              {customer.displayName}’s account now: owes{' '}
              <strong data-testid="account-after-owes">
                {formatMinor(owes, accountAfter!.currencyExponent)}
              </strong>{' '}
              · advances available{' '}
              <strong data-testid="account-after-advances">
                {formatMinor(adv, accountAfter!.currencyExponent)}
              </strong>{' '}
              {accountAfter!.currencyCode}
            </p>
          ) : null}
          <ReceiptView model={receipt} />
          <div className="row gap no-print">
            <button
              className="btn btn--touch btn--primary"
              onClick={() => window.print()}
              data-testid="print"
            >
              Print receipt
            </button>
            <button className="btn btn--touch" onClick={onNewSale} data-testid="new-sale">
              New sale
            </button>
          </div>
        </div>
      </div>
    );
  }

  const cardParsed = amount(cardText);
  const payable = totalMinor - advanceSum;
  const cashDue =
    mode === 'CASH'
      ? payable
      : mode === 'SPLIT' &&
          typeof cardParsed === 'bigint' &&
          cardParsed > 0n &&
          cardParsed < payable
        ? payable - cardParsed
        : null;
  const quick =
    cashDue !== null && cashDue > 0n && totals ? quickCashAmounts(cashDue, exponent) : [];
  const fmt = (m: bigint): string => formatMinor(m, exponent);
  const hasAdvances = (account?.advances.length ?? 0) > 0;
  const modes: SettleMode[] = customer
    ? ['CASH', 'CARD', 'SPLIT', 'CREDIT']
    : ['CASH', 'CARD', 'SPLIT'];
  const modeLabel: Record<SettleMode, string> = {
    CASH: 'Cash',
    CARD: 'Card',
    SPLIT: 'Split',
    CREDIT: 'On credit',
  };
  const attempted =
    cashText !== '' ||
    cardText !== '' ||
    depositText !== '' ||
    advanceSum > 0n ||
    mode === 'CARD' ||
    mode === 'CREDIT';

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Checkout">
      <div className="modal__panel">
        <div className="modal__head">
          <h2>Checkout{customer ? ` · ${customer.displayName}` : ''}</h2>
          {phase !== 'paying' ? (
            <button className="btn btn--touch" onClick={onClose} aria-label="Close">
              ✕
            </button>
          ) : null}
        </div>

        {phase === 'preparing' ? <p className="muted">Calculating totals…</p> : null}

        {totals ? (
          <dl className="totals" data-testid="totals">
            <div>
              <dt>Subtotal</dt>
              <dd data-testid="co-subtotal">{formatMinor(totals.subtotalAmountMinor, exponent)}</dd>
            </div>
            {BigInt(totals.documentDiscountAmountMinor) > 0n ? (
              <div>
                <dt>Discount</dt>
                <dd>−{formatMinor(totals.documentDiscountAmountMinor, exponent)}</dd>
              </div>
            ) : null}
            <div>
              <dt>VAT</dt>
              <dd data-testid="co-vat">{formatMinor(totals.taxTotalAmountMinor, exponent)}</dd>
            </div>
            <div className="totals__grand">
              <dt>Total {totals.currencyCode}</dt>
              <dd data-testid="co-total">{formatMinor(totals.totalAmountMinor, exponent)}</dd>
            </div>
          </dl>
        ) : null}

        {totals && customer ? (
          <section className="account" data-testid="account-panel" aria-label="Customer account">
            <h3>Customer account</h3>
            {account === null ? (
              <p className="muted">Reading the customer’s account…</p>
            ) : account.summary ? (
              <dl className="totals">
                <div>
                  <dt>Owes now</dt>
                  <dd data-testid="account-owes">
                    {formatMinor(
                      account.summary.branchFinancials.receivableOutstandingMinor,
                      account.summary.currencyExponent,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Advances available</dt>
                  <dd data-testid="account-advances">
                    {formatMinor(
                      account.summary.branchFinancials.advanceAvailableMinor,
                      account.summary.currencyExponent,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Credit</dt>
                  <dd data-testid="account-credit">
                    {!account.summary.credit.creditEnabled
                      ? 'not enabled'
                      : account.summary.credit.availableCreditMinor === null
                        ? 'no limit set'
                        : `${formatMinor(account.summary.credit.availableCreditMinor, account.summary.currencyExponent)} available`}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="muted" data-testid="account-note">
                {account.note}
              </p>
            )}
          </section>
        ) : null}

        {totals && hasAdvances ? (
          <section className="advances" data-testid="advances-panel" aria-label="Customer advances">
            <h3>Use an advance</h3>
            {account!.advances.map((a, i) => (
              <div className="row gap" key={a.advanceId}>
                <label className="field" style={{ flex: 1 }}>
                  <span>
                    Advance {i + 1} — {fmt(a.availableMinor)} available
                  </span>
                  <input
                    value={advanceText[a.advanceId] ?? ''}
                    onChange={(e) =>
                      setAdvanceText({ ...advanceText, [a.advanceId]: e.target.value })
                    }
                    inputMode="decimal"
                    data-testid={`advance-input-${i}`}
                  />
                </label>
                <button
                  className="btn btn--touch"
                  type="button"
                  onClick={() => useAdvance(a)}
                  data-testid={`advance-use-${i}`}
                >
                  Use max
                </button>
              </div>
            ))}
            {advanceSum > 0n && advanceSum <= totalMinor ? (
              <p className="muted" data-testid="left-to-pay">
                Left to pay after advances:{' '}
                <strong>{formatMinor(totalMinor - advanceSum, exponent)}</strong>
              </p>
            ) : null}
          </section>
        ) : null}

        {totals ? (
          <div className="stack">
            <div className="seg" role="tablist" aria-label="Payment method">
              {modes.map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  className={`seg__btn${mode === m ? ' seg__btn--on' : ''}`}
                  onClick={() => setMode(m)}
                  data-testid={`mode-${m}`}
                >
                  {modeLabel[m]}
                </button>
              ))}
            </div>

            {mode === 'SPLIT' ? (
              <label className="field">
                <span>Card amount</span>
                <input
                  value={cardText}
                  onChange={(e) => setCardText(e.target.value)}
                  inputMode="decimal"
                  data-testid="card-amount"
                />
              </label>
            ) : null}

            {mode === 'CASH' || mode === 'SPLIT' ? (
              payable <= 0n ? (
                <p className="muted" data-testid="advance-covers">
                  The advance covers the whole sale — nothing to take.
                </p>
              ) : (
                <>
                  <label className="field">
                    <span>Cash handed over by the customer</span>
                    <input
                      value={cashText}
                      onChange={(e) => setCashText(e.target.value)}
                      inputMode="decimal"
                      data-testid="cash-received"
                    />
                  </label>
                  <div className="quick">
                    {quick.map((q) => (
                      <button
                        key={q.toString()}
                        className="btn btn--touch"
                        onClick={() => setCashText(formatMinor(q, exponent).replace(/,/g, ''))}
                      >
                        {formatMinor(q, exponent)}
                      </button>
                    ))}
                  </div>
                </>
              )
            ) : null}

            {mode === 'CARD' ? (
              <p className="muted">
                Take the payment on the card terminal, then confirm. No card data is entered here.
              </p>
            ) : null}

            {mode === 'CREDIT' ? (
              <div className="stack" data-testid="credit-panel">
                <p className="muted">
                  The part not paid now goes on {customer?.displayName}’s account. The system checks
                  the credit limit.
                </p>
                <div className="row gap">
                  <label className="field" style={{ flex: 1 }}>
                    <span>Paid now (optional)</span>
                    <input
                      value={depositText}
                      onChange={(e) => setDepositText(e.target.value)}
                      inputMode="decimal"
                      data-testid="credit-deposit"
                    />
                  </label>
                  <div className="seg" role="tablist" aria-label="Paid now by">
                    {(['CASH', 'CARD'] as const).map((m) => (
                      <button
                        key={m}
                        role="tab"
                        aria-selected={depositMethod === m}
                        className={`seg__btn${depositMethod === m ? ' seg__btn--on' : ''}`}
                        onClick={() => setDepositMethod(m)}
                        data-testid={`deposit-${m}`}
                      >
                        {m === 'CASH' ? 'Cash' : 'Card'}
                      </button>
                    ))}
                  </div>
                </div>
                {advisory?.state === 'DISABLED' ? (
                  <p className="error" data-testid="credit-advisory">
                    Credit is not enabled for this customer.
                  </p>
                ) : advisory?.state === 'OVER' ? (
                  <p className="error" data-testid="credit-advisory">
                    This is {fmt(advisory.overByMinor)} over the customer’s available credit (
                    {fmt(advisory.availableMinor)}). The system will refuse it unless an owner
                    approves an exception.
                  </p>
                ) : advisory?.state === 'WITHIN' ? (
                  <p className="muted" data-testid="credit-advisory">
                    Within the customer’s available credit ({fmt(advisory.availableMinor)}).
                  </p>
                ) : null}
                {needException ? (
                  <label className="field">
                    <span>Reason for the credit exception (an owner must approve)</span>
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      maxLength={255}
                      data-testid="credit-reason"
                    />
                  </label>
                ) : null}
              </div>
            ) : null}

            {plan.ok ? (
              <dl className="totals" data-testid="payment-figures">
                <div>
                  <dt>Advance applied</dt>
                  <dd data-testid="figure-advance">{fmt(plan.figures.advanceMinor)}</dd>
                </div>
                <div>
                  <dt>Paid now</dt>
                  <dd data-testid="figure-paynow">{fmt(plan.figures.payNowMinor)}</dd>
                </div>
                {plan.request.paymentIntent === 'ON_CREDIT' ? (
                  <div className="totals__grand">
                    <dt>On credit</dt>
                    <dd data-testid="figure-credit">{fmt(plan.figures.creditMinor)}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}

            {plan.ok && plan.changeDueMinor > 0n ? (
              <p className="change" data-testid="change-due">
                Change to hand back: <strong>{formatMinor(plan.changeDueMinor, exponent)}</strong>
                <span className="muted">
                  {' '}
                  — the sale is recorded as the exact amount due; handed-over cash and change are
                  not recorded.
                </span>
              </p>
            ) : null}
            {!plan.ok && attempted ? (
              <p className="muted" data-testid="plan-refusal">
                {CREDIT_REFUSAL_TEXT[plan.reason]}
              </p>
            ) : null}
          </div>
        ) : null}

        {vatBlock ? (
          <p className="error" role="alert" data-testid="vat-blocked">
            {vatBlock}
          </p>
        ) : null}

        {error ? (
          <p className="error" role="alert" data-testid="checkout-error">
            {error}
          </p>
        ) : null}

        {needStepUp ? (
          <div className="row gap" data-testid="stepup-panel">
            <label className="field" style={{ flex: 1 }}>
              <span>Verification code</span>
              <input
                value={stepUpCode}
                onChange={(e) => setStepUpCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                data-testid="stepup-code"
              />
            </label>
            <button
              className="btn btn--touch"
              type="button"
              onClick={() => void verifyStepUp()}
              disabled={stepUpCode.trim().length < 6}
              data-testid="stepup-verify"
            >
              Verify
            </button>
          </div>
        ) : null}

        <div className="row gap">
          {totals ? (
            <button
              className="btn btn--touch btn--primary btn--xl"
              disabled={!plan.ok || phase === 'paying' || vatBlock !== null}
              onClick={() => void pay()}
              data-testid="confirm-payment"
            >
              {phase === 'paying'
                ? 'Processing…'
                : mode === 'CREDIT'
                  ? 'Confirm sale on credit'
                  : 'Confirm payment'}
            </button>
          ) : phase !== 'preparing' ? (
            <button className="btn btn--touch" onClick={() => void prepare()}>
              Try again
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

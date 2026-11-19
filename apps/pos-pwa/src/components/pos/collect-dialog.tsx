'use client';

import { useMemo, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { PosCollectMethod, PosCustomerReceivableRow } from '@flower/api-client';
import { authed, describeError, newKey } from '@/lib/api';
import {
  COLLECT_METHODS,
  COLLECT_REFUSAL_TEXT,
  buildCollectionReceipt,
  collectErrorMessage,
  collectKeyFor,
  newCollectAttempt,
  planCollection,
  type CollectAttempt,
  type CollectionReceiptModel,
} from '@/lib/collection';
import { saveCollection, sessionKeyValueStore } from '@/lib/collection-store';
import { formatMinor, parseAmountInput } from '@/lib/money-display';
import type { ReceiptSeller } from '@/lib/receipt';
import { CollectionReceiptView } from './collection-receipt-view';

/**
 * COLLECT A PAYMENT ON A CUSTOMER'S ACCOUNT. The cashier enters an amount and how it was tendered (cash, bank transfer or other — the frozen contract does
 * not accept card here). The SERVER allocates it to the customer's open invoices, oldest first, and answers with the allocation; this dialog shows that
 * answer, re-reads the server's balance, and offers a printable receipt. A retry of the same collection (a lost response) reuses its Idempotency-Key, so
 * the payment is never taken twice; a SUCCESSFUL collection starts a fresh attempt.
 */
export function CollectDialog({
  companyId,
  branchId,
  branchName,
  seller,
  customer,
  currencyCode,
  exponent,
  outstandingMinor,
  receivables,
  attemptRef,
  onCollected,
  onClose,
}: {
  companyId: string;
  branchId: string;
  branchName: string | null;
  seller: ReceiptSeller;
  customer: { id: string; displayName: string };
  currencyCode: string;
  exponent: number;
  /** the SERVER's outstanding balance for this customer at this branch */
  outstandingMinor: bigint;
  /** the open receivables the server listed — only to name the invoices on the receipt */
  receivables: readonly PosCustomerReceivableRow[];
  attemptRef: MutableRefObject<CollectAttempt>;
  /** called once the server has recorded the collection (the account is reloaded) */
  onCollected: () => void;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<PosCollectMethod>('CASH');
  const [amountText, setAmountText] = useState('');
  const [phase, setPhase] = useState<'form' | 'paying' | 'done'>('form');
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<CollectionReceiptModel | null>(null);

  const parsed =
    amountText.trim() === '' ? null : (parseAmountInput(amountText, exponent) ?? undefined);
  const plan = useMemo(
    () => planCollection({ outstandingMinor, amountMinor: parsed, method }),
    [outstandingMinor, parsed, method],
  );
  const fmt = (m: bigint): string => formatMinor(m, exponent);
  const oldest = receivables[0];

  async function confirm(): Promise<void> {
    if (!plan.ok || phase === 'paying') return;
    setPhase('paying');
    setError(null);
    const request = plan.request;
    try {
      const { attempt, key } = collectKeyFor(attemptRef.current, customer.id, request, newKey);
      attemptRef.current = attempt;
      const result = await authed((a) =>
        a.collectCustomerReceipt(companyId, branchId, customer.id, request, key),
      );
      // recorded: the next collection (even of the same amount) is a NEW payment
      attemptRef.current = newCollectAttempt();
      // the account AFTER the collection — the server's balance and clock, never a figure calculated here
      let balanceAfterMinor: string | null = null;
      let asOf: string | null = null;
      try {
        const s = await authed((a) =>
          a.getCustomerAccountSummary(companyId, branchId, customer.id),
        );
        balanceAfterMinor = s.branchFinancials.receivableOutstandingMinor;
        asOf = s.asOf;
      } catch {
        /* the collection is recorded; the receipt simply carries no balance */
      }
      const snapshot = {
        customerName: customer.displayName,
        method,
        result,
        receivables: receivables.map((r) => ({
          customerReceivableId: r.customerReceivableId,
          invoiceNumber: r.invoiceNumber,
          sourceType: r.sourceType,
        })),
        balanceAfterMinor,
        asOf,
      };
      saveCollection(sessionKeyValueStore(), customer.id, snapshot);
      setReceipt(buildCollectionReceipt({ ...snapshot, seller, branchName, copy: 'ORIGINAL' }));
      setPhase('done');
      onCollected();
    } catch (err) {
      const d = describeError(err);
      setError(
        d.status === 0
          ? collectErrorMessage('NETWORK', 0)
          : `${collectErrorMessage(d.code, d.status)} (${d.code})`,
      );
      setPhase('form');
    }
  }

  if (phase === 'done' && receipt) {
    return (
      <div className="modal" role="dialog" aria-modal="true" aria-label="Payment received">
        <div className="modal__panel modal__panel--receipt">
          <p className="success" data-testid="collect-complete">
            Payment recorded ✓
          </p>
          <CollectionReceiptView model={receipt} />
          <div className="row gap no-print">
            <button
              className="btn btn--touch btn--primary"
              onClick={() => window.print()}
              data-testid="collect-print"
            >
              Print receipt
            </button>
            <button className="btn btn--touch" onClick={onClose} data-testid="collect-done">
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Collect payment">
      <div className="modal__panel">
        <div className="modal__head">
          <h2>Collect payment · {customer.displayName}</h2>
          {phase !== 'paying' ? (
            <button className="btn btn--touch" onClick={onClose} aria-label="Close">
              ✕
            </button>
          ) : null}
        </div>

        <dl className="totals" data-testid="collect-owes-panel">
          <div className="totals__grand">
            <dt>Owes now {currencyCode}</dt>
            <dd data-testid="collect-owes">{fmt(outstandingMinor)}</dd>
          </div>
        </dl>

        <div className="stack">
          <div className="seg" role="tablist" aria-label="Payment method">
            {COLLECT_METHODS.map((m) => (
              <button
                key={m.value}
                role="tab"
                aria-selected={method === m.value}
                className={`seg__btn${method === m.value ? ' seg__btn--on' : ''}`}
                onClick={() => setMethod(m.value)}
                data-testid={`collect-method-${m.value}`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <label className="field">
            <span>Amount received</span>
            <input
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              inputMode="decimal"
              data-testid="collect-amount"
            />
          </label>
          <div className="quick">
            <button
              className="btn btn--touch"
              type="button"
              onClick={() => setAmountText(fmt(outstandingMinor).replace(/,/g, ''))}
              data-testid="collect-full"
            >
              Full balance
            </button>
            {oldest ? (
              <button
                className="btn btn--touch"
                type="button"
                onClick={() =>
                  setAmountText(formatMinor(oldest.outstandingMinor, exponent).replace(/,/g, ''))
                }
                data-testid="collect-oldest"
              >
                Oldest invoice{oldest.invoiceNumber ? ` (${oldest.invoiceNumber})` : ''}
              </button>
            ) : null}
          </div>

          {plan.ok ? (
            <p className="muted" data-testid="collect-preview">
              Preview: about <strong>{fmt(plan.remainingAfterMinor)}</strong> would still be owed.
              The system applies the money to the oldest invoices first and shows the exact result.
            </p>
          ) : amountText.trim() !== '' ? (
            <p className="muted" data-testid="collect-refusal">
              {COLLECT_REFUSAL_TEXT[plan.reason]}
            </p>
          ) : null}

          {method === 'CASH' ? (
            <p className="muted" data-testid="collect-register-note">
              Cash taken here is recorded on the customer’s account only. It is not yet linked to
              the cash-register count — keep it aside for your end-of-day check.
            </p>
          ) : null}
        </div>

        {error ? (
          <p className="error" role="alert" data-testid="collect-error">
            {error}
          </p>
        ) : null}

        <div className="row gap">
          <button
            className="btn btn--touch btn--primary btn--xl"
            disabled={!plan.ok || phase === 'paying'}
            onClick={() => void confirm()}
            data-testid="collect-confirm"
          >
            {phase === 'paying' ? 'Recording…' : 'Confirm payment'}
          </button>
        </div>
      </div>
    </div>
  );
}

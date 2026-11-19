'use client';

import { useEffect, useState } from 'react';
import type { PosCustomerRow } from '@flower/api-client';
import { authed, describeError, newKey } from '@/lib/api';

/**
 * Pick the customer for a sale: search by name / phone / e-mail, or create one on the spot, or continue as a walk-in (no customer).
 * The company comes from the verified till context; customers are listed through the guarded API (tenant + company scoped).
 */
export function CustomerPicker({
  companyId,
  canCreate,
  onSelect,
  onClose,
}: {
  companyId: string;
  canCreate: boolean;
  onSelect: (c: PosCustomerRow | null) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PosCustomerRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const term = q.trim();
        const query =
          term === ''
            ? {}
            : /^[+\d][\d\s-]{4,}$/.test(term)
              ? { phone: term.replace(/[\s-]/g, '') }
              : term.includes('@')
                ? { email: term }
                : { displayName: term };
        const page = await authed((a) => a.listCustomers(companyId, query));
        if (!cancelled) setRows(page.data);
      } catch (err) {
        const d = describeError(err);
        if (!cancelled) setError(`${d.code}: ${d.message}`);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, companyId]);

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const phone = newPhone.trim();
      const c = await authed((a) =>
        a.createCustomer(
          companyId,
          { displayName: newName.trim(), ...(phone ? { phone } : {}) },
          newKey(),
        ),
      );
      onSelect(c);
    } catch (err) {
      const d = describeError(err);
      setError(`${d.code}: ${d.message}`);
      setBusy(false);
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Select customer">
      <div className="modal__panel">
        <div className="modal__head">
          <h2>Customer</h2>
          <button className="btn btn--touch" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {creating ? (
          <div className="stack">
            <label className="field">
              <span>Name</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
                data-testid="new-customer-name"
              />
            </label>
            <label className="field">
              <span>Phone (optional)</span>
              <input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                inputMode="tel"
              />
            </label>
            <div className="row gap">
              <button
                className="btn btn--touch btn--primary"
                disabled={busy || newName.trim() === ''}
                onClick={() => void create()}
                data-testid="create-customer"
              >
                Save customer
              </button>
              <button className="btn btn--touch" onClick={() => setCreating(false)}>
                Back
              </button>
            </div>
          </div>
        ) : (
          <div className="stack">
            <input
              className="search"
              placeholder="Search name, phone or e-mail"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
              data-testid="customer-search"
            />
            <ul className="picklist" data-testid="customer-results">
              {rows.map((c) => (
                <li key={c.id}>
                  <button className="picklist__item" onClick={() => onSelect(c)}>
                    <strong>{c.displayName}</strong>
                    <span className="muted">{c.phoneE164 ?? c.emailNormalized ?? ''}</span>
                  </button>
                </li>
              ))}
              {!busy && rows.length === 0 ? <li className="muted">No customers found.</li> : null}
            </ul>
            <div className="row gap">
              <button
                className="btn btn--touch"
                onClick={() => onSelect(null)}
                data-testid="walk-in"
              >
                Walk-in (no customer)
              </button>
              {canCreate ? (
                <button
                  className="btn btn--touch"
                  onClick={() => {
                    setCreating(true);
                    setNewName(q.trim());
                  }}
                >
                  + New customer
                </button>
              ) : null}
            </div>
          </div>
        )}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

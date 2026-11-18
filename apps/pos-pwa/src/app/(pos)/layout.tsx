'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PosProvider, usePos } from '@/components/pos/pos-context';

const REFUSAL_TEXT: Record<string, string> = {
  NO_SELL_PERMISSION:
    'Your account is not allowed to sell (it needs the orders permission). Ask the owner.',
  NO_BRANCH_SCOPE: 'Your account is not assigned to a branch. Ask the owner to assign one.',
  NO_COMPANY_SCOPE: 'Your account is not assigned to a company. Ask the owner to assign one.',
};

function Shell({ children }: { children: React.ReactNode }) {
  const pos = usePos();
  const path = usePathname();

  if (pos.status === 'loading')
    return (
      <p className="muted content" data-testid="pos-loading">
        Loading…
      </p>
    );
  if (pos.status === 'error')
    return (
      <p className="error content" role="alert">
        {pos.error}
      </p>
    );
  if (pos.status === 'refused') {
    return (
      <div className="content">
        <p className="error" role="alert" data-testid="pos-refused">
          {REFUSAL_TEXT[pos.refusal ?? ''] ?? 'This account cannot use the till.'}
        </p>
        <button className="btn btn--touch" onClick={() => void pos.signOut()}>
          Sign out
        </button>
      </div>
    );
  }
  const ctx = pos.context!;
  return (
    <div className="posshell">
      <header className="topbar no-print">
        <strong className="topbar__brand">{ctx.companyName ?? 'Flower POS'}</strong>
        {ctx.branchChoices.length > 1 ? (
          <select
            value={ctx.branchId}
            onChange={(e) => pos.selectBranch(e.target.value)}
            aria-label="Branch"
            className="topbar__branch"
          >
            {ctx.branchChoices.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name ?? b.id.slice(0, 8)}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted">{ctx.branchName ?? ''}</span>
        )}
        <nav className="topbar__nav">
          <Link href="/sell" className={path?.startsWith('/sell') ? 'on' : ''}>
            Sell
          </Link>
          {ctx.canViewSales ? (
            <Link href="/sales" className={path?.startsWith('/sales') ? 'on' : ''}>
              Sales
            </Link>
          ) : null}
          {ctx.canViewAccounts ? (
            <Link href="/customers" className={path?.startsWith('/customers') ? 'on' : ''}>
              Customers
            </Link>
          ) : null}
          <Link href="/access">Access</Link>
        </nav>
        <button className="btn" onClick={() => void pos.signOut()} data-testid="sign-out">
          Sign out
        </button>
      </header>
      <main className="posmain">{children}</main>
    </div>
  );
}

export default function PosLayout({ children }: { children: React.ReactNode }) {
  return (
    <PosProvider>
      <Shell>{children}</Shell>
    </PosProvider>
  );
}

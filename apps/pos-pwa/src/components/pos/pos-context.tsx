'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MeAccess, OrgBranchRow, OrgCompanyRow } from '@flower/api-client';
import { bootstrapSession, getAccessToken, signOut as endSession } from '@/lib/auth';
import { authed, describeError } from '@/lib/api';
import { resolveContext, type ContextRefusal, type PosContext } from '@/lib/context';
import { sellerFromIdentity, type ReceiptSeller } from '@/lib/receipt';

interface PosState {
  status: 'loading' | 'ready' | 'refused' | 'error';
  access: MeAccess | null;
  context: PosContext | null;
  seller: ReceiptSeller;
  refusal: ContextRefusal | null;
  error: string | null;
}

interface PosApi extends PosState {
  selectBranch: (branchId: string) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<PosApi | null>(null);
const BRANCH_KEY = 'flower.pos.branch'; // a non-sensitive UI preference (never a credential)

function readPref(): string | null {
  try {
    return window.localStorage.getItem(BRANCH_KEY);
  } catch {
    return null;
  }
}
function writePref(v: string): void {
  try {
    window.localStorage.setItem(BRANCH_KEY, v);
  } catch {
    /* private mode / blocked storage: the preference is optional */
  }
}

const NO_SELLER: ReceiptSeller = { name: null, trn: null, address: null };

export function PosProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<PosState>({
    status: 'loading',
    access: null,
    context: null,
    seller: NO_SELLER,
    refusal: null,
    error: null,
  });
  const [org, setOrg] = useState<{ c: OrgCompanyRow[] | null; b: OrgBranchRow[] | null }>({
    c: null,
    b: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      if (!getAccessToken() && !(await bootstrapSession())) {
        if (!cancelled) router.replace('/login');
        return;
      }
      try {
        const access = await authed((a) => a.meAccess());
        // the organisation lists need `settings:tenant:manage` (Owner / Admin); a cashier simply has none and uses the ids in their scope
        let companies: OrgCompanyRow[] | null = null;
        let branches: OrgBranchRow[] | null = null;
        if (access.permissions.includes('settings:tenant:manage')) {
          try {
            [companies, branches] = await Promise.all([
              authed((a) => a.listOrgCompanies()),
              authed((a) => a.listOrgBranches()),
            ]);
          } catch {
            /* optional enrichment */
          }
        }
        if (cancelled) return;
        setOrg({ c: companies, b: branches });
        const r = resolveContext(access, companies, branches, readPref());
        if (!r.ok) {
          setState({
            status: 'refused',
            access,
            context: null,
            seller: NO_SELLER,
            refusal: r.reason,
            error: null,
          });
          return;
        }
        // the receipt header: the cashier-readable seller identity (own company + branch scope); an owner's org list is only a fallback
        let seller: ReceiptSeller = NO_SELLER;
        try {
          const identity = await authed((c) =>
            c.getReceiptIdentity(r.context.companyId, r.context.branchId),
          );
          seller = sellerFromIdentity(identity);
        } catch {
          const company = companies?.find((c) => c.id === r.context.companyId);
          seller = sellerFromIdentity(
            company
              ? {
                  legalNameEn: company.legalNameEn,
                  trn: company.trn ?? null,
                  registeredAddress: company.registeredAddress ?? null,
                }
              : null,
          );
        }
        if (cancelled) return;
        setState({
          status: 'ready',
          access,
          context: r.context,
          seller,
          refusal: null,
          error: null,
        });
      } catch (err) {
        const d = describeError(err);
        if (d.status === 401) {
          await endSession();
          if (!cancelled) router.replace('/login');
          return;
        }
        if (!cancelled)
          setState((s) => ({ ...s, status: 'error', error: `${d.code}: ${d.message}` }));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const selectBranch = useCallback(
    (branchId: string) => {
      if (!state.access) return;
      const r = resolveContext(state.access, org.c, org.b, branchId);
      if (r.ok) {
        writePref(branchId);
        setState((s) => ({ ...s, context: r.context }));
      }
    },
    [state.access, org],
  );

  const signOut = useCallback(async () => {
    await endSession();
    router.replace('/login');
  }, [router]);

  const value = useMemo<PosApi>(
    () => ({ ...state, selectBranch, signOut }),
    [state, selectBranch, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePos(): PosApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePos outside PosProvider');
  return v;
}

/** the ready context, or throws: use inside screens rendered only when `status === 'ready'` */
export function useReadyContext(): PosContext {
  const { context } = usePos();
  if (!context) throw new Error('POS context not ready');
  return context;
}

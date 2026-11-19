import type { PosCollectMethod, PosCustomerReceiptResult } from '@flower/api-client';

/**
 * The till has NO way to read a past collection back from the server (there is no payment read route and the server issues no receipt number), so the
 * server's own ANSWER to each collection made in this browser tab is kept in `sessionStorage` — only so the receipt can be printed again (marked COPY).
 * It is a convenience copy of server values, never an authority: it is bounded, cleared when the tab closes, read defensively, and a reprint prints exactly
 * what the server returned at the time.
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CollectionSnapshot {
  customerName: string;
  method: PosCollectMethod;
  result: PosCustomerReceiptResult;
  receivables: { customerReceivableId: string; invoiceNumber: string | null; sourceType: string }[];
  balanceAfterMinor: string | null;
  asOf: string | null;
}

const KEEP = 5;
const keyOf = (customerId: string): string => `flower.pos.collections.${customerId}`;

const isSnapshot = (v: unknown): v is CollectionSnapshot => {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<CollectionSnapshot>;
  return (
    typeof s.customerName === 'string' &&
    typeof s.result === 'object' &&
    s.result !== null &&
    typeof s.result.paymentId === 'string' &&
    typeof s.result.amountMinor === 'string' &&
    Array.isArray(s.result.allocations) &&
    Array.isArray(s.receivables)
  );
};

export function loadCollections(
  store: KeyValueStore | null,
  customerId: string,
): CollectionSnapshot[] {
  if (!store) return [];
  try {
    const raw = store.getItem(keyOf(customerId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSnapshot) : [];
  } catch {
    return [];
  }
}

export function saveCollection(
  store: KeyValueStore | null,
  customerId: string,
  snapshot: CollectionSnapshot,
): void {
  if (!store) return;
  try {
    const rest = loadCollections(store, customerId).filter(
      (x) => x.result.paymentId !== snapshot.result.paymentId,
    );
    store.setItem(keyOf(customerId), JSON.stringify([snapshot, ...rest].slice(0, KEEP)));
  } catch {
    /* a full or blocked store only means no reprint of this one — the collection itself is already recorded */
  }
}

/** the part of the browser Storage API needed to enumerate and remove keys */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

const PREFIX = 'flower.pos.collections.';

/** sign-out: forget every kept collection receipt, for every customer, so a shared till never shows the previous user's receipts */
export function clearCollections(store: StorageLike | null): void {
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (k !== null && k.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) store.removeItem(k);
  } catch {
    /* best effort */
  }
}

/** the browser's tab-session store, or null when unavailable (private mode, server render) */
export function sessionKeyValueStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

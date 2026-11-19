import { describe, expect, it } from 'vitest';
import {
  clearCollections,
  loadCollections,
  saveCollection,
  type CollectionSnapshot,
  type KeyValueStore,
  type StorageLike,
} from './collection-store';

const mem = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};
const snap = (paymentId: string): CollectionSnapshot => ({
  customerName: 'Dora Debtor',
  method: 'CASH',
  result: {
    paymentId,
    paymentAttemptId: 'a',
    amountMinor: '1000',
    allocatedAmountMinor: '1000',
    unallocatedAmountMinor: '0',
    currencyCode: 'AED',
    currencyExponent: 2,
    allocations: [{ receivableId: 'r1', sourceType: 'INVOICE', amountMinor: '1000' }],
  },
  receivables: [{ customerReceivableId: 'r1', invoiceNumber: 'INV-000001', sourceType: 'INVOICE' }],
  balanceAfterMinor: '2000',
  asOf: '2026-11-18T10:00:00.000Z',
});

describe('collection store — the SERVER’s answer to this session’s collections, kept only so a receipt can be printed again', () => {
  it('keeps the newest collections per customer, newest first, bounded', () => {
    const s = mem();
    for (let i = 1; i <= 7; i += 1) saveCollection(s, 'cust-1', snap(`p${i}`));
    const list = loadCollections(s, 'cust-1');
    expect(list.map((x) => x.result.paymentId)).toEqual(['p7', 'p6', 'p5', 'p4', 'p3']);
    expect(loadCollections(s, 'cust-2')).toEqual([]);
  });
  it('saving the same payment twice keeps one entry', () => {
    const s = mem();
    saveCollection(s, 'c', snap('p1'));
    saveCollection(s, 'c', snap('p1'));
    expect(loadCollections(s, 'c')).toHaveLength(1);
  });
  it('a missing, unreadable or tampered store reads as empty and never throws; a failing write is swallowed', () => {
    expect(loadCollections(null, 'c')).toEqual([]);
    const bad = mem();
    bad.data.set('flower.pos.collections.c', '{not json');
    expect(loadCollections(bad, 'c')).toEqual([]);
    bad.data.set('flower.pos.collections.c', JSON.stringify([{ nonsense: true }, snap('ok')]));
    expect(loadCollections(bad, 'c').map((x) => x.result.paymentId)).toEqual(['ok']);
    const failing: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => saveCollection(failing, 'c', snap('p'))).not.toThrow();
    expect(() => saveCollection(null, 'c', snap('p'))).not.toThrow();
  });
});

describe('sign-out clears every kept collection (a shared till must not show the previous user’s receipts)', () => {
  it('removes only this feature’s keys, for every customer', () => {
    const data = new Map<string, string>([
      ['flower.pos.collections.c1', '[]'],
      ['flower.pos.collections.c2', '[]'],
      ['flower.pos.branch', 'b1'],
    ]);
    const store: StorageLike = {
      get length() {
        return data.size;
      },
      key: (i) => [...data.keys()][i] ?? null,
      removeItem: (k) => void data.delete(k),
    };
    clearCollections(store);
    expect([...data.keys()]).toEqual(['flower.pos.branch']);
    expect(() => clearCollections(null)).not.toThrow();
  });
});

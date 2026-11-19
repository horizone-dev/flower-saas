'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  addLine,
  cartCount,
  clearCart,
  parseCart,
  removeLine,
  serializeCart,
  setQuantity,
  type Cart,
  type CartLine,
} from '@/lib/cart';

const STORAGE_KEY = 'flower.cart.v1';

interface CartApi {
  cart: Cart;
  /** false until the browser's saved cart has been read (so the first paint never flashes an empty cart) */
  ready: boolean;
  count: number;
  add: (line: Omit<CartLine, 'quantity'>, quantity: number) => void;
  setQty: (variantId: string, quantity: number) => void;
  remove: (variantId: string) => void;
  clear: () => void;
}

const Ctx = createContext<CartApi | null>(null);

/** browser storage can be unavailable (private windows, blocked site data): every access is guarded and the cart simply lives in memory then */
function read(): Cart {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? parseCart(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}
function write(cart: Cart): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeCart(cart));
  } catch {
    /* in-memory only */
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<Cart>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setCart(read());
    setReady(true);
    // another tab changed the cart: follow it
    const onStorage = (e: StorageEvent): void => {
      if (e.key === STORAGE_KEY) setCart(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const update = useCallback((fn: (c: Cart) => Cart) => {
    setCart((prev) => {
      const next = fn(prev);
      write(next);
      return next;
    });
  }, []);

  const api = useMemo<CartApi>(
    () => ({
      cart,
      ready,
      count: cartCount(cart),
      add: (line, quantity) => update((c) => addLine(c, line, quantity)),
      setQty: (variantId, quantity) => update((c) => setQuantity(c, variantId, quantity)),
      remove: (variantId) => update((c) => removeLine(c, variantId)),
      clear: () => update(() => clearCart()),
    }),
    [cart, ready, update],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useCart(): CartApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCart must be used inside CartProvider');
  return v;
}

'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  BranchEffectiveCatalogEntry,
  PosCustomerRow,
  ProductRow,
  VariantRow,
} from '@flower/api-client';
import { authed, describeError, newKey } from '@/lib/api';
import { buildTiles, filterTiles, type CatalogTile } from '@/lib/catalog';
import {
  EMPTY_CART,
  cartReducer,
  estimateSubtotalMinor,
  isEmpty,
  unitCount,
  type CartLine,
} from '@/lib/cart';
import { newAttempt, type CheckoutAttempt } from '@/lib/checkout';
import { formatMinor } from '@/lib/money-display';
import { CheckoutDialog } from './checkout-dialog';
import { CustomerPicker } from './customer-picker';
import { useReadyContext, usePos } from './pos-context';

const MAX_PAGES = 20;

async function loadCatalog(branchId: string): Promise<{
  products: ProductRow[];
  effective: BranchEffectiveCatalogEntry[];
}> {
  const products: ProductRow[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await authed((a) =>
      a.listProducts({ status: 'ACTIVE', ...(cursor ? { cursor } : {}) }),
    );
    products.push(...page.data);
    if (!page.hasNextPage || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const effective: BranchEffectiveCatalogEntry[] = [];
  let ec: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await authed((a) =>
      a.getBranchEffectiveCatalog(branchId, ec ? { cursor: ec } : {}),
    );
    effective.push(...page.entries);
    if (!page.nextCursor) break;
    ec = page.nextCursor;
  }
  return { products, effective };
}

export function SellScreen() {
  const context = useReadyContext();
  const { seller } = usePos();
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [effective, setEffective] = useState<BranchEffectiveCatalogEntry[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cart, dispatch] = useReducer(cartReducer, EMPTY_CART);
  const [customer, setCustomer] = useState<PosCustomerRow | null>(null);
  const [pickCustomer, setPickCustomer] = useState(false);
  const [chooser, setChooser] = useState<{
    tile: CatalogTile;
    names: Record<string, string>;
  } | null>(null);
  const [checkout, setCheckout] = useState(false);
  const attemptRef = useRef<CheckoutAttempt>(newAttempt(newKey));
  const [variantNames, setVariantNames] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    try {
      const r = await loadCatalog(context.branchId);
      setProducts(r.products);
      setEffective(r.effective);
      setLoadState('ready');
    } catch (err) {
      const d = describeError(err);
      setLoadError(`${d.code}: ${d.message}`);
      setLoadState('error');
    }
  }, [context.branchId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const tiles = useMemo(() => buildTiles(products, effective), [products, effective]);
  const shown = useMemo(
    () => filterTiles(tiles, query, variantNames),
    [tiles, query, variantNames],
  );

  async function openTile(tile: CatalogTile): Promise<void> {
    if (!tile.sellable) return;
    const sellable = tile.entries.filter((e) => e.available);
    if (sellable.length === 1) {
      addEntry(tile, sellable[0]!, null);
      return;
    }
    // several variants: read their names (one call) so the cashier can choose
    let names: Record<string, string> = {};
    try {
      const vs: VariantRow[] = await authed((a) => a.listVariants(tile.productId));
      names = Object.fromEntries(vs.map((v) => [v.id, v.nameEn]));
      setVariantNames((prev) => ({ ...prev, ...names }));
    } catch {
      /* names are optional: the chooser falls back to the price */
    }
    setChooser({ tile, names });
  }

  function addEntry(
    tile: CatalogTile,
    e: CatalogTile['entries'][number],
    variantName: string | null,
  ): void {
    dispatch({
      type: 'add',
      line: {
        productId: tile.productId,
        variantId: e.variantId,
        uomCode: e.uomCode,
        name: tile.name,
        variantName,
        unitPriceMinor: e.priceMinor,
      },
    });
    setChooser(null);
  }

  const estimate = estimateSubtotalMinor(cart);
  const exponent = tiles[0]?.exponent ?? 2;
  const currency = tiles[0]?.currency ?? '';

  function resetAfterSale(): void {
    attemptRef.current = newAttempt(newKey);
    setCustomer(null);
    setCheckout(false);
  }

  return (
    <div className="sell">
      <section className="sell__catalog" aria-label="Products">
        <div className="sell__bar">
          <input
            className="search"
            type="search"
            placeholder="Search products…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="product-search"
            aria-label="Search products"
          />
          <button
            className="btn btn--touch"
            onClick={() => void reload()}
            aria-label="Reload catalog"
          >
            ↻
          </button>
        </div>
        {loadState === 'loading' ? <p className="muted">Loading products…</p> : null}
        {loadState === 'error' ? (
          <p className="error" role="alert">
            {loadError}{' '}
            <button className="btn" onClick={() => void reload()}>
              Retry
            </button>
          </p>
        ) : null}
        {loadState === 'ready' && tiles.length === 0 ? (
          <p className="muted" data-testid="empty-catalog">
            No products are on sale in this branch yet. The owner must activate a product, give it a
            price and make it available here.
          </p>
        ) : null}
        <ul className="tiles" data-testid="tiles">
          {shown.map((t) => (
            <li key={t.productId}>
              <button
                className={`tile${t.sellable ? '' : ' tile--off'}`}
                disabled={!t.sellable}
                onClick={() => void openTile(t)}
                data-testid={`tile-${t.name}`}
              >
                <span className="tile__name">{t.name}</span>
                <span className="tile__price">
                  {t.sellable && t.fromPriceMinor !== null && t.exponent !== null
                    ? `${t.multiVariant ? 'from ' : ''}${formatMinor(t.fromPriceMinor, t.exponent)}`
                    : 'Unavailable'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <aside className="sell__cart" aria-label="Cart">
        <div className="cart__head">
          <h2>
            Cart{' '}
            <span className="badge" data-testid="cart-count">
              {unitCount(cart)}
            </span>
          </h2>
          <button
            className="btn"
            onClick={() => dispatch({ type: 'clear' })}
            disabled={isEmpty(cart)}
          >
            Clear
          </button>
        </div>
        <ul className="cart__lines" data-testid="cart-lines">
          {cart.lines.map((l: CartLine) => (
            <li key={l.key} className="cart__line">
              <div className="cart__name">
                <strong>{l.name}</strong>
                {l.variantName ? <span className="muted"> · {l.variantName}</span> : null}
                <div className="muted">{formatMinor(l.unitPriceMinor, exponent)} each</div>
              </div>
              <div className="qty">
                <button
                  className="btn btn--touch"
                  onClick={() => dispatch({ type: 'decrement', key: l.key })}
                  aria-label={`Remove one ${l.name}`}
                >
                  −
                </button>
                <span className="qty__n" data-testid={`qty-${l.name}`}>
                  {l.quantity}
                </span>
                <button
                  className="btn btn--touch"
                  onClick={() => dispatch({ type: 'increment', key: l.key })}
                  aria-label={`Add one ${l.name}`}
                >
                  +
                </button>
              </div>
              <button
                className="btn"
                onClick={() => dispatch({ type: 'remove', key: l.key })}
                aria-label={`Remove ${l.name}`}
              >
                ✕
              </button>
            </li>
          ))}
          {isEmpty(cart) ? <li className="muted">Tap a product to add it.</li> : null}
        </ul>

        <button
          className="btn btn--touch btn--block"
          onClick={() => setPickCustomer(true)}
          data-testid="select-customer"
        >
          {customer ? `Customer: ${customer.displayName}` : 'Customer: walk-in (tap to change)'}
        </button>

        {!isEmpty(cart) ? (
          <p className="muted" data-testid="estimate">
            {estimate !== null
              ? `Estimate before VAT: ${currency} ${formatMinor(estimate, exponent)} · `
              : ''}
            final total and VAT are confirmed at checkout
          </p>
        ) : null}

        <button
          className="btn btn--touch btn--primary btn--xl btn--block"
          disabled={isEmpty(cart)}
          onClick={() => setCheckout(true)}
          data-testid="charge"
        >
          Charge
        </button>
      </aside>

      {pickCustomer ? (
        <CustomerPicker
          companyId={context.companyId}
          canCreate={context.canCreateCustomer}
          onSelect={(c) => {
            setCustomer(c);
            setPickCustomer(false);
          }}
          onClose={() => setPickCustomer(false)}
        />
      ) : null}

      {chooser ? (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Choose variant">
          <div className="modal__panel">
            <div className="modal__head">
              <h2>{chooser.tile.name}</h2>
              <button
                className="btn btn--touch"
                onClick={() => setChooser(null)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <ul className="picklist">
              {chooser.tile.entries.map((e) => (
                <li key={e.variantId}>
                  <button
                    className="picklist__item"
                    disabled={!e.available}
                    onClick={() => addEntry(chooser.tile, e, chooser.names[e.variantId] ?? null)}
                  >
                    <strong>{chooser.names[e.variantId] ?? 'Variant'}</strong>
                    <span>
                      {e.available ? formatMinor(e.priceMinor, e.exponent) : 'Unavailable'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {checkout ? (
        <CheckoutDialog
          cart={cart}
          customer={customer}
          context={context}
          seller={seller}
          attemptRef={attemptRef}
          onSold={() => dispatch({ type: 'clear' })}
          onNewSale={resetAfterSale}
          onClose={() => setCheckout(false)}
        />
      ) : null}
    </div>
  );
}

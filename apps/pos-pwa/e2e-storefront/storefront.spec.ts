import { expect, test, type Page } from '@playwright/test';

/**
 * CUSTOMER WEB storefront on a phone-sized screen. Everything runs against the in-memory DEMO catalog: this proves the browsing, variant, cart and
 * review screens and the English / Arabic (right-to-left) layout — NOT ordering, payment, booking, delivery or stock (none of those contracts exists).
 */
const requests: string[] = [];

test.beforeEach(async ({ page }) => {
  requests.length = 0;
  page.on('request', (r) => requests.push(r.url()));
  // a clean cart for every journey
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.clear();
        sessionStorage.setItem('seeded', '1');
      }
    } catch {
      /* storage unavailable */
    }
  });
});

/** pick an option the way a shopper does: click its visible label (Playwright scrolls it clear of the sticky add bar) */
const choose = (page: Page, testId: string) =>
  page
    .locator('label.chip')
    .filter({ has: page.getByTestId(testId) })
    .click();

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('browse: the demo banner, the grid, the category rail, search and the empty state', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('demo-banner')).toContainText('Demo catalog');
  await expect(page.getByTestId('product-card')).toHaveCount(8);
  await expect(page.getByTestId('result-count')).toHaveText('8 products');

  // price tags: "from" the cheapest AVAILABLE price, a hidden price stays hidden
  const roses = page.getByTestId('product-card').filter({ hasText: 'Red roses' });
  await expect(roses).toContainText('from AED 150.00');
  await expect(page.getByTestId('product-card').filter({ hasText: 'Chocolate box' })).toContainText(
    'Price shown when you order',
  );
  expect(await noHorizontalScroll(page)).toBe(true);

  await page.getByTestId('cat-plants').click();
  await expect(page).toHaveURL(/category=plants/);
  await expect(page.getByTestId('product-card')).toHaveCount(1);
  await expect(page.getByTestId('product-card')).toContainText('Orchid in a pot');

  await page.goto('/');
  await page.getByTestId('search-input').fill('  ROSE ');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByTestId('product-card')).toHaveCount(2);

  await page.getByTestId('search-input').fill('zzzz');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByTestId('shop-empty')).toContainText('Nothing matches');
  await page.getByRole('link', { name: 'Clear search' }).click();
  await expect(page.getByTestId('product-card')).toHaveCount(8);
});

test('product: variants change the price, an unavailable or unpriced variant cannot be added, an available one can', async ({
  page,
}) => {
  await page.goto('/p/red-roses');
  await expect(page.getByTestId('product-name')).toHaveText('Red roses');
  await expect(page.getByTestId('variant-price')).toContainText('AED 150.00');

  await choose(page, 'opt-val-roses-m');
  await expect(page.getByTestId('variant-price')).toContainText('AED 260.00');

  // the 36-stem option is not available: it says so, and the add button is disabled
  await expect(page.locator('label.chip', { hasText: '36 stems' })).toContainText('Not available');
  await choose(page, 'opt-val-roses-l');
  await expect(page.getByTestId('variant-status')).toContainText('Not available right now');
  await expect(page.getByTestId('add-to-cart')).toBeDisabled();

  // back to an available one; quantity 2; add
  await choose(page, 'opt-val-roses-s');
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByTestId('qty')).toHaveText('2');
  await page.getByTestId('add-to-cart').click();
  await expect(page.getByTestId('added-status')).toContainText('Added to your cart');
  await expect(page.getByTestId('cart-count')).toHaveText('2');

  // a variant the shop has not priced yet cannot be added
  await page.goto('/p/spring-tulips');
  await choose(page, 'opt-val-tulip-l');
  await choose(page, 'opt-val-tulip-white');
  await expect(page.getByTestId('variant-status')).toContainText('Price not set yet');
  await expect(page.getByTestId('add-to-cart')).toBeDisabled();

  // the add bar stays reachable on a phone and nothing overflows sideways
  await page.goto('/p/blush-peonies');
  await expect(page.getByTestId('add-to-cart')).toBeInViewport();
  expect(await noHorizontalScroll(page)).toBe(true);

  await page.goto('/p/does-not-exist');
  await expect(page.getByTestId('product-not-found')).toBeVisible();
});

test('cart: lines, quantity, remove, an indicative subtotal, a hidden price, and it survives a reload', async ({
  page,
}) => {
  await page.goto('/p/red-roses');
  await page.getByTestId('add-to-cart').click(); // 12 stems, 150.00
  await page.goto('/p/glass-vase');
  await page.getByTestId('add-to-cart').click(); // 65.00
  await page.goto('/p/chocolate-box');
  await expect(page.getByTestId('variant-status')).toContainText('Price shown when you order');
  await page.getByTestId('add-to-cart').click(); // hidden price

  await page.goto('/cart');
  await expect(page.getByTestId('cart-line')).toHaveCount(3);
  // 150.00 + 65.00 = 215.00; the hidden-price line is left out and the page says so
  await expect(page.getByTestId('subtotal')).toHaveText('AED 215.00');
  await expect(page.getByTestId('hidden-note')).toContainText('1 items');
  await expect(page.getByText('An estimate before VAT and delivery')).toBeVisible();

  const rose = page.getByTestId('cart-line').filter({ hasText: 'Red roses' });
  await rose.getByRole('button', { name: 'More' }).click();
  await expect(rose.getByTestId('line-qty')).toHaveText('2');
  await expect(page.getByTestId('subtotal')).toHaveText('AED 365.00');
  await expect(page.getByTestId('cart-count')).toHaveText('4');

  await page.reload();
  await expect(page.getByTestId('cart-line')).toHaveCount(3);
  await expect(page.getByTestId('subtotal')).toHaveText('AED 365.00');

  await page
    .getByTestId('cart-line')
    .filter({ hasText: 'Glass vase' })
    .getByTestId('line-remove')
    .click();
  await expect(page.getByTestId('cart-line')).toHaveCount(2);
  await expect(page.getByTestId('subtotal')).toHaveText('AED 300.00');
  expect(await noHorizontalScroll(page)).toBe(true);

  await page.getByTestId('clear-cart').click();
  await expect(page.getByTestId('cart-empty')).toBeVisible();
});

test('a damaged or tampered saved cart is ignored, never a crash', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() =>
    localStorage.setItem(
      'flower.cart.v1',
      JSON.stringify([
        { variantId: 'x', quantity: 'many' },
        { variantId: 'y', unitPriceMinor: '12.50', quantity: 1 },
        'nonsense',
      ]),
    ),
  );
  await page.goto('/cart');
  await expect(page.getByTestId('cart-empty')).toBeVisible();
  await page.evaluate(() => localStorage.setItem('flower.cart.v1', '{not json'));
  await page.goto('/cart');
  await expect(page.getByTestId('cart-empty')).toBeVisible();
});

test('review: ordering is honestly closed — nothing can be placed and nothing is sent anywhere', async ({
  page,
}) => {
  await page.goto('/p/white-lilies');
  await page.getByTestId('add-to-cart').click();
  await page.goto('/cart');
  await page.getByTestId('review-order').click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.getByTestId('cart-line')).toHaveCount(1);
  await expect(page.getByTestId('ordering-closed')).toContainText(
    'Online ordering is not open yet',
  );
  await expect(page.getByTestId('ordering-closed')).toContainText('Nothing has been sent');
  await expect(page.getByTestId('place-order')).toBeDisabled();

  // the storefront only ever talks to itself: no API, no payment provider, no third party
  const origin = new URL(page.url()).origin;
  const foreign = requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:'));
  expect(foreign).toEqual([]);
  expect(requests.filter((u) => /\/v1\//.test(u))).toEqual([]);
});

test('Arabic: right-to-left layout, Arabic names and labels, the same prices, and back to English', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('lang-switch').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('product-card').first()).toBeVisible();
  await expect(page.getByTestId('product-card').filter({ hasText: 'ورد جوري أحمر' })).toContainText(
    '150.00',
  );
  expect(await noHorizontalScroll(page)).toBe(true);

  await page.goto('/p/red-roses');
  await expect(page.getByTestId('product-name')).toHaveText('ورد جوري أحمر');
  await page.getByTestId('add-to-cart').click();
  await expect(page.getByTestId('added-status')).toContainText('تمت الإضافة');
  await page.goto('/cart');
  await expect(page.getByTestId('cart-line')).toContainText('ورد جوري أحمر');
  await expect(page.getByTestId('subtotal')).toContainText('150.00');
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.goto('/checkout');
  await expect(page.getByTestId('ordering-closed')).toContainText('غير متاح');
  expect(await noHorizontalScroll(page)).toBe(true);

  // the language is remembered; switching back restores English and left-to-right
  await page.getByTestId('lang-switch').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

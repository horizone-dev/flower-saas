# Customer Web storefront — audit, what is built, and the missing backend contracts

**Status: BUILT AS A DEMO-CATALOG STOREFRONT. LOCAL ONLY — nothing is committed, pushed, merged or deployed, and no shopper can order anything.**
Written 2026-11-18 in `C:\Users\EXPERT\fwt\p4` (uncommitted). No migration, no frozen-contract change, no new endpoint.

## 1. The audit: what the backend offers a shopper today

**Nothing.** There is no shopper-facing backend at all.

| Area                                                | What exists                                                                                                                                                                                                      | What a shopper can do with it                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Public (`@Public()`) routes                         | `healthz`, `readyz`; device `activate` + `challenge` (POS terminals); staff `login`, `mfa/verify`, `refresh`, `set-password`; platform `login`; the payment **webhook receiver** (`POST …/webhooks/:endpointId`) | none (health, staff auth, terminals, a provider callback)                                          |
| Identity realms                                     | `PLATFORM` and tenant `OWNER` / `USER` (staff). `SECURITY.md` §3–4 _describes_ per-tenant customer identity and anonymous storefront tokens                                                                      | **no code, no route, no session type** for either                                                  |
| Catalog reads                                       | `/v1/catalog/{categories,products,variants,…/option-groups,…/prices}`, `/v1/catalog/branches/:b/catalog` (effective price + availability) — all `catalog:view` behind a **tenant staff session**                 | a shopper has no session; handing the site a staff token would be a security hole, so none is used |
| Orders                                              | `POST /v1/companies/:c/branches/:b/orders` (`orders:manage`), complete-sale, receipts — staff/POS only                                                                                                           | no shopper route; **no `channel` column** on `order` (schema has no `CUSTOMER_WEB`)                |
| Payments                                            | staff-side payment collection + the provider **webhook receiver**                                                                                                                                                | no shopper "start a payment" route; no provider vendor chosen (Z-4)                                |
| Storefront config / host→tenant / published catalog | **no module, no schema** (`storefront`, `tenant_domain`, `published_catalog_item` are Phase 7 in the roadmap)                                                                                                    | —                                                                                                  |
| Delivery / slots / reservation / soft hold          | **no schema**, no route (stock availability + reservation services exist as inert staff-side code)                                                                                                               | —                                                                                                  |
| Media                                               | the catalog contract has **no image field**                                                                                                                                                                      | —                                                                                                  |

Conclusion (rule: _do not invent working booking, payment, delivery or stock-reservation capabilities_): the storefront reads a **demo catalog** and orders nothing.

## 2. What is built (`apps/customer-web`, mobile-first, English + Arabic/RTL)

- **Browse** (`/`): category rail, search (English and Arabic names), product grid; "from" price = cheapest _available, priced_ variant; a hidden price stays hidden; an unavailable product says so.
- **Product** (`/p/:slug`): option groups as chips, the matching variant's price (the catalog's figure, formatted from integer minor units), unavailable / not-yet-priced variants shown and **not addable**, quantity, sticky add-to-cart bar on phones.
- **Cart** (`/cart`): lines, quantity, remove, empty, an **indicative** subtotal (exact integers; excludes hidden-price lines and says so; "the shop confirms the final price"). Stored in the browser only; a damaged or tampered saved cart is dropped, never a crash. Adding to a cart never reserves stock (rule 24).
- **Review** (`/checkout`): the same lines read-only and a plain statement that **online ordering is not open**; the "Place order" button is **disabled** and nothing is sent anywhere (a browser test asserts zero API and zero third-party requests).
- **Language**: English / Arabic cookie, `<html lang dir>` set on the server, logical CSS properties so RTL mirrors, Arabic names/labels, key-parity test between the two catalogs.
- **Design**: cold-room palette (ink green, stem green, cold white, kraft + marigold); the price is a kraft **hang-tag** with a punched hole. Product art is a **neutral placeholder bloom** (no media contract; deliberately never a product colour). No web fonts, no external requests.
- **Architecture**: `StorefrontCatalogPort` (shapes mirror `CategoryRow`, `ProductRow`, `VariantRow`, `OptionGroupWithValues`, the branch effective price/availability entry) with ONE adapter — the in-memory demo catalog. There is no environment switch and no API call in the app: a live adapter is a separate, reviewed change once §3 exists. The demo is labelled on every page.

## 3. Missing backend contracts (kept separate — none is invented here)

Each needs an owner decision and, where noted, a migration or a security review.

1. **Tenant resolution + storefront config** — host → tenant (custom domain / subdomain), shop name, branding, currency/country, contact channels. _(Phase 7: `storefront_config`, `tenant_domain`; migration.)_
2. **Shopper identity** — anonymous storefront token and/or phone-OTP / account realm, per tenant, with abuse limits. _(New auth realm: independent security review.)_
3. **Public published-catalog read API** — categories, products, variants, option groups, effective branch price, availability, as a _projection_ safe for anonymous reads (no staff data, per-tenant cache keys). Gaps in today's shapes: **no media**, **no Arabic description** (`description` is one English field), no search endpoint, no published/visibility flag beyond `status`.
4. **Branch routing** — delivery address zone or pickup-branch choice → fulfilling branch (drives price, availability, slots).
5. **Order channel + shopper order contract** — `order.channel` (`CUSTOMER_WEB`) does not exist; a guest/account order route with recipient ≠ buyer, card message, hide-price, substitution policy; a **server quote** (totals with VAT, discounts, delivery) so the page shows the server's figures instead of an estimate. _(Schema change → migration; frozen order contracts → owner approval.)_
6. **Availability, soft hold and reservation** for shoppers — the 10-minute checkout soft hold (Z-10) and reservation on confirm, through the one `AvailabilityService`; today only inert staff-side services exist.
7. **Online payment** — a shopper "start payment" route per the branch's Super-Admin-configured provider; provider vendor not selected (Z-4); the webhook receiver exists, nothing initiates.
8. **Delivery** — zones, charges, time slots, slot capacity, delivery events/proof (no schema → migration) and the POS **Online Orders queue** + realtime event the architecture promises.
9. **Custom bouquet options** — no catalog contract (BOM/recipe stock code is inert); not offered.
10. **Storefront hardening** — rate limiting, CORS, CSP, per-tenant cache-key tests, the "storefront + customer realm" cross-tenant probe suite (ROADMAP Phase 7 exit criteria).

**Dependency order:** (1) + (3) → read-only live catalog (no migration needed for a _read projection_ if config is env-based, but still new public routes ⇒ security review) → (2) + (5)–(8) → ordering → (10) before any public launch.

## 4. How a future live adapter maps (so the UI does not change)

| Port method                   | Existing staff contract it mirrors                                     |
| ----------------------------- | ---------------------------------------------------------------------- |
| `listCategories`              | `GET /v1/catalog/categories`                                           |
| `listProducts` / `getProduct` | `GET /v1/catalog/products` (+ `…/variants`, `…/option-groups`)         |
| variant `price` / `available` | `GET /v1/catalog/branches/:b/catalog` (effective price + availability) |
| `hidePrice`                   | `ProductRow.hidePrice`                                                 |

The adapter must be fed by a **shopper-scoped** projection (§3.3), never by a staff session.

## 5. Tests

- Unit (Vitest): cart (10), storefront catalog + demo-catalog integrity (10), i18n parity/direction (5), money (2), bloom (3) — **29 passing**.
- Browser (Playwright, 390×844 mobile, one worker, no API or database): **6 journeys passing** — browse/search/empty, variants + unavailable/unpriced, cart + subtotal + hidden price + persistence + remove, tampered storage, review (ordering closed, zero outbound API/third-party requests), Arabic/RTL round trip. Each also asserts no horizontal scroll at 390 px.
- Run: `pnpm --dir apps/customer-web exec next build` then, from `apps/pos-pwa`, `node ./node_modules/@playwright/test/cli.js test -c playwright.storefront.config.ts` (the spec and config live under `apps/pos-pwa` because Playwright is installed there; port 3500).
- Not covered: a real screen-reader pass, tablet/desktop visual review beyond the CSS, performance budgets, anything touching a backend.

# Post-Phase-1 — Authentication hardening

> A focused, owner-requested security remediation performed **after**
> `phase-1-complete` (`d44566b`) and **before** Phase 2. Phase 1 stays
> historically complete; the `phase-1-complete` tag is untouched. This work lands
> as one separate `fix(auth)` commit on `main`.
>
> Date: 2026-09-04 · Executor: Claude Sonnet 5 (Claude Code)

---

## A. Trigger & current-state inspection

The Phase 1.12 report described the POS PWA as storing its **access + refresh
tokens in `localStorage`**. The owner does not approve a persistent refresh
credential in JavaScript-readable storage.

**Inspection of the code as it stood on `main` (not the report):**

| File                                               | Finding                                                                                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/pos-pwa/src/lib/auth.ts`                     | `localStorage.setItem('pos_access', …)` **and** `localStorage.setItem('pos_refresh', …)` via `setTokens()`; `getToken()` read `pos_access` from `localStorage`. |
| `apps/pos-pwa/src/app/login/page.tsx`              | called `setTokens(accessToken, refreshToken)` — persisted both.                                                                                                 |
| `apps/pos-pwa/src/app/access/page.tsx`, `page.tsx` | gated on `getToken()` (localStorage read).                                                                                                                      |
| `apps/owner-web`, `apps/super-admin-web`           | **not affected** — tokens already server-side only, in `HttpOnly` cookies set by the Next server; the browser never holds them.                                 |

**Confirmed: still true for the POS PWA.** Remediation required.

---

## B. Remediation performed

### POS PWA — no auth credential in JS-readable storage

- **Access token → module memory only** (`let accessToken` in `auth.ts`). A tab
  reload drops it and it is re-bootstrapped from the refresh cookie. No
  `localStorage` / `sessionStorage` / `IndexedDB` / `document.cookie` access
  remains in the module (asserted by test).
- **Refresh token → `Secure; HttpOnly; SameSite=Lax` cookie** named
  `flower_refresh`, `Path=/v1/auth`, set by the API. JavaScript cannot read it.
- Protected POS API calls stay **Bearer** (`Authorization: <in-memory access
token>`).
- `bootstrapSession()` exchanges the cookie for a fresh in-memory access token
  (`POST /v1/auth/refresh`, empty body); `signOut()` reaches the server to revoke
  (session + refresh family) then clears memory.

### API — dual refresh-token transport

`apps/api/src/modules/identity/auth.controller.ts` + new
`apps/api/src/common/http/cookies.ts` (dependency-free parse/serialize — works
identically under `main.ts` and `app.inject`):

- A client opts into the cookie flow with **`X-Auth-Transport: cookie`**.
  - `login` / `mfa/verify` with the header → refresh token is set as the
    `flower_refresh` cookie and **withheld from the response body**.
  - without the header (owner-web / super-admin-web) → unchanged: refresh token in
    the body, no cookie.
- `refresh`:
  - reads the token from the body **or** the `flower_refresh` cookie;
  - a **cookie-sourced** refresh **must** carry `X-Auth-Transport: cookie` — a
    cross-site page cannot set a custom header on a credentialed request, and a
    form POST cannot set it at all → missing ⇒ **`403 CSRF_BLOCKED`**;
  - rotates the cookie on success.
- `logout` always emits a `Set-Cookie` that clears `flower_refresh`
  (`Max-Age=0`), in addition to revoking the session + refresh family server-side.

### API — CORS for the credentialed flow

`apps/api/src/main.ts`:

- `credentials: true` (needed for the cookie); origin list stays an **exact
  allow-list, never `*`**; `x-auth-transport` added to `allowedHeaders`.

`apps/api/src/config/env.ts`:

- In production, `loadConfig` now **rejects** a `CORS_ORIGINS` entry that is `*`
  or `http(s)://localhost[:port]` — a credentialed CORS surface must name real
  origins. (Dev/CI defaults unchanged.)

### `@flower/api-client`

- New `credentials` and `headers` options, applied to every request.
- `refresh(refreshToken?)` — the argument is now optional (omit ⇒ cookie flow,
  empty body).

---

## C. Tests added

| Test                                                                                | Proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/pos-pwa/src/lib/auth.test.ts` (4)                                             | the module never calls a web-storage API or `document.cookie`; `setAccessToken` writes no storage; `bootstrapSession` uses `credentials:'include'` + `x-auth-transport` + **no `refreshToken` in the request body**; a failed bootstrap clears memory.                                                                                                                                                                                                                         |
| `apps/api/src/modules/identity/auth-cookie.integration.test.ts` (7, Testcontainers) | cookie-login withholds the body token + sets `HttpOnly; Secure; SameSite=Lax; Path=/v1/auth`; body-login unchanged; cookie refresh rotates + returns only an access token; **cookie refresh without the header ⇒ 403 `CSRF_BLOCKED`**; an explicit body `refreshToken` still works; replaying a rotated cookie ⇒ 401 `REFRESH_REUSED` + family dead; logout clears the cookie (`Max-Age=0`) + kills the session (`/v1/me` ⇒ 401) + the cookie no longer continues the session. |
| `apps/api/src/config/env.test.ts` (+2)                                              | production refuses `CORS_ORIGINS=*` or a `localhost` entry; dev defaults untouched.                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/api-client/src/index.test.ts` (+2)                                        | `credentials` + default `headers` reach `fetch`; the refresh token is never in the body on the cookie flow; `credentials` omitted when not configured.                                                                                                                                                                                                                                                                                                                         |

Re-run of the existing suites (rotation/reuse, logout/revocation, realm
separation, tenant isolation, probes) — see §D.

---

## D. Verification

Local (`main` + this change, 2026-09-04):

| Check                                             | Result                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm -w typecheck`                               | 30/30 tasks ✅                                                                                                                                                                                                                                                                                 |
| `pnpm -w lint`                                    | 31/31 ✅                                                                                                                                                                                                                                                                                       |
| `pnpm -w build`                                   | 20/20 ✅                                                                                                                                                                                                                                                                                       |
| `pnpm --filter @flower/api test` (Testcontainers) | **18 files / 137 tests ✅** (was 17 / 128 — +1 file `auth-cookie.integration.test.ts`, +9 tests: 7 cookie-flow + 2 CORS-guard). Run twice, identical. Includes the unchanged rotation/reuse, logout/revocation, realm-separation, tenant-isolation and cross-tenant/realm/branch probe suites. |
| `pnpm --filter @flower/api-client test`           | 7 ✅ (was 5)                                                                                                                                                                                                                                                                                   |
| `pnpm --filter @flower/pos-pwa test`              | 4 ✅ (new file)                                                                                                                                                                                                                                                                                |
| Super Admin Web e2e smoke (`test:e2e`)            | 1 passed ✅ — login (TOTP) → provision → lifecycle → role assign → preview → impersonation (mutation blocked) → secret (masked). Unaffected: the web apps send no `X-Auth-Transport` header, so login keeps the body transport.                                                                |
| GitHub CI (`verify` / `security` / `e2e`)         | ✅ all three green — commit `57952a4`, run [`33849116789`](https://github.com/horizone-dev/flower-saas/actions/runs/33849116789).                                                                                                                                                              |

---

## E. CSRF review — Owner Web / Super Admin Web (the recorded LOW / OI2)

**Current posture (unchanged by this work):** session tokens in `HttpOnly` +
`Secure` (prod) + `SameSite=Lax` cookies; every state-changing operation goes
through a Next.js **Server Action**, which enforces an **Origin/Host check** on
the POST. `SameSite=Lax` additionally stops the cookie riding a cross-site form
POST. This is the framework-canonical CSRF defence for an App-Router app and is
adequate.

**Proposal (not implemented — for owner decision):**

1. **Keep the explicit double-submit / `__Host-` CSRF token deferred.** Layering a
   hand-rolled token on top of the Server Action Origin check is redundant attack
   surface for no concrete gain in this architecture (each web app has its own
   origin — OD1 — so there is no sibling-subdomain cookie-sharing path).
2. **Small hardening that is safe to add now, if approved:** pin
   `serverActions.allowedOrigins` in each web app's `next.config` (from an env
   var, defaulting to the dev origin). This is the client-side complement to the
   API's new strict CORS allow-list and closes the Host-header-spoof edge behind
   a misconfigured proxy. Config-only, ~3 lines per app.

No code for either item is included in this commit.

---

## Remaining security deferrals (unchanged from `PHASE-1-RESULTS.md` §5)

- `audit_log` hash chain; outbox dispatcher; GL postings (ADR-0016).
- WebAuthn / passkeys (OD2); self-service password reset (OD3); managed-KMS
  provider (OD4 / G16).
- Host / custom-domain login resolution (OD5); registered-device enforcement
  (amendment 1).
- **Explicit CSRF token for the cookie realms — still deferred (OI2)**; see §E for
  the updated rationale. The POS PWA cookie-refresh path added here **does** carry
  an explicit CSRF control (the required `X-Auth-Transport` header).
- Per-tenant `LimitService` coverage for all 10 limits.

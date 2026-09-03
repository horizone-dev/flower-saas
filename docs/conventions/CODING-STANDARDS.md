# Coding standards

## Language & compiler

- **TypeScript strict** everywhere. `tsconfig.base.json` sets `strict`,
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes`,
  `forceConsistentCasingInFileNames`. Packages extend it.
- `module`/`moduleResolution`: `NodeNext`. ESM throughout.
- No `any` in committed code. `unknown` + a narrowing guard, or a precise type.
  `// @ts-expect-error` requires a comment explaining why and a follow-up.
- No non-null assertion `!` on values that can genuinely be null — narrow instead.
  Exception: test fixtures.

## Module boundaries (lint-enforced — ADR-0001, ADR-0004)

- Authoritative business logic lives **only in `apps/api`** (imported by `worker` /
  `scheduler`). `packages/*` hold contracts, constants and **pure** utilities only.
- A domain module never imports another module's repository/Prisma models — only its
  **exported service interface** or a **domain event**. (`eslint-plugin-boundaries`.)
- **`no-raw-prisma-in-scoped-modules`** — scoped modules access data only through
  `ScopedRepository`.
- **`route-must-declare-permission`** — every controller route has
  `@RequirePermission(...)` or `@Public()`.
- **`no-scope-from-request`** — `tenant_id` / `branch_id` may not be read from a
  request body / param / header / query / subscription string.
- `packages/money` and `packages/uom` are **pure**: no I/O, no Date.now, no
  randomness, deterministic.

## Naming

- Files: `kebab-case.ts`. One primary export per file where reasonable.
- Types/interfaces/classes/enums: `PascalCase`. Variables/functions: `camelCase`.
  Constants: `UPPER_SNAKE_CASE`. Permission keys: `domain:action[:qualifier]`.
- DB tables & columns: `snake_case`, singular table names (`order`, not `orders`).
- Money DTO fields: `<name>_minor`, `<name>_currency`, `<name>_exponent` (or a
  `Money` object from `packages/shared-types`).
- Event types: `resource.verb` (`order.created`, `inventory.changed`).

## Error handling

- One global error envelope (see [`API-CONVENTIONS.md`](API-CONVENTIONS.md)). Domain
  errors are typed classes extending a base `DomainError` with a stable `code`.
- **Fail closed** in the guard pipeline. Never swallow an error to "keep going" on a
  money / stock / auth path.
- No secrets, PII, tokens or raw request bodies in error messages or logs (redaction
  filter + tests).
- Every external call (provider, storage, queue) has a timeout and a typed failure.

## Async, transactions, idempotency

- A cross-domain effect commits in **one DB transaction** with **one `outbox` row**
  (CLAUDE.md 28–29). Downstream handlers are **idempotent**.
- Every external-facing or retryable write takes an `Idempotency-Key`; a dedup table
  returns the original result on retry.
- Stock/financial writes lock `(branch_id, item_id)` (or an advisory lock) and
  re-check inside the lock.

## Comments & docs

- Comment **why**, not what. Match the surrounding file's density and idiom.
- Public service methods and DTOs get a one-line doc comment. Posting templates,
  X/Z formulas and the availability algorithm get a reference comment pointing at
  the ADR / architecture section.

## Formatting & lint

- Prettier (`.prettierrc.json`) — 100 col, single quotes, semicolons, trailing
  commas. ESLint flat config from `packages/config`. Both run in pre-commit
  (lefthook) and CI. **CI lint failure blocks merge.**

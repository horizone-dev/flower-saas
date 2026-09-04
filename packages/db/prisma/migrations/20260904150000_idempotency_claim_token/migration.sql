-- Task 2.2 hardening: a dedicated opaque per-claim lease token.
-- `markDone` / `release` match on `claimToken`, so a stale owner can never
-- complete or release a newer owner's claim. `lockedAt` stays only the
-- lease/staleness timestamp. Additive, forward-only; the table is empty in prod.
ALTER TABLE "idempotency_key" ADD COLUMN "claimToken" UUID;

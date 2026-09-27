import { Injectable } from '@nestjs/common';
import type { RequestContext } from '../../common/context/index.js';
import { DomainError, ForbiddenError } from '../../common/errors/domain-error.js';
import { PolicyEngine } from '../access/policy-engine.js';

// Task 3b.6 Checkpoint C hardening — a private, UNEXPORTED `Symbol` as the
// brand key (rather than a plain string-literal property) is a genuine
// runtime/structural trust boundary, not merely a documentation convention:
// TypeScript's structural typing means a plain string-literal-keyed brand
// (`{ __brand: 'AuthorizedCreditOverride' }`) COULD be reproduced by any
// caller who types the same literal string — a `Symbol` cannot, because no
// other module can reference this exact Symbol instance without importing
// it, and it is never exported. A hand-built object literal from an HTTP DTO
// (which would have to be declared as a plain JSON-shaped type — no zod
// schema can produce a value keyed by an un-importable Symbol) can therefore
// never structurally satisfy `AuthorizedCreditOverride`, at compile time or
// at runtime. This is NOT cryptography — it is ordinary TypeScript nominal-
// typing-via-Symbol, the same technique used for structurally opaque
// "branded" ids elsewhere in this ecosystem. The actual, load-bearing trust
// boundary beyond the type system is procedural: no zod DTO schema anywhere
// in this codebase declares a `creditOverride` field, no controller exists
// yet that reads one from a request body, and `authorize()` below is the
// ONLY function in the entire codebase that can construct this brand.
// Task 3b.9 (the first real caller) MUST continue to produce this value
// ONLY via `CreditOverrideAuthorizationService.authorize`, never by
// accepting a client-supplied boolean/object — this is the contract this
// module exists to enforce, and no future DTO may re-introduce a
// `creditOverride`/`overrideCreditLimit`-shaped field.
const OVERRIDE_BRAND: unique symbol = Symbol('AuthorizedCreditOverride');

/** Task 3b.2 precedent (`documentDiscountReason`/`discountReason` DTOs,
 *  `z.string().trim().min(1).max(255)`) — reused verbatim for the override
 *  reason rather than inventing a new bound. */
export const CREDIT_OVERRIDE_REASON_MAX_LENGTH = 255;

/**
 * Task 3b.6 Checkpoint C — the ONE-SALE credit-limit override decision.
 *
 * `issueFinalInvoice` has no live public controller yet (Task 3b.9 will be
 * the first real caller) — so there is nothing to attach `@RequirePermission`/
 * step-up guards to. This service is the "access layer" C11 requires: it is
 * the ONLY way to produce an `AuthorizedCreditOverride`, and it does so by
 * running the EXACT SAME `PolicyEngine.can()` check a real HTTP guard would
 * (reusing `customers:credit:override`, frozen Owner-only in Task 3b.2, and
 * now also step-up-gated — see `@flower/permissions` `STEP_UP_PERMISSIONS`).
 * `PolicyEngine.can()` already denies with `STEP_UP_REQUIRED` when the key
 * requires step-up and `ctx.mfaLevel !== 'STEP_UP'` — this class adds only
 * the reason/actor requirements that are specific to the override itself.
 *
 * `AuthorizedCreditOverride` is a Symbol-branded, structurally-opaque type —
 * see `OVERRIDE_BRAND` above for why nothing outside this file can construct
 * one — so `CustomerInvoiceArRepository` can trust a value of this type
 * WITHOUT re-deriving the authorization itself. An untrusted
 * `overrideCreditLimit: true` boolean is never accepted anywhere in this
 * call chain.
 *
 * The override is intentionally single-use / non-persistent: it is a plain
 * value passed into ONE `issueFinalInvoice` call and never stored — it never
 * mutates `creditEnabled`/`creditLimitMinor`/any credit-configuration version.
 * It authorizes bypassing `CUSTOMER_CREDIT_LIMIT_EXCEEDED` ONLY — a customer
 * with `creditEnabled=false` (never extended credit at all) remains an
 * unconditional hard block, never overridable this way (3b.6 architecture
 * decision, this hardening pass §11 — ADR-0019 §1 describes the override only
 * in terms of "a sale that would push `current_outstanding` past
 * `credit_limit`", never in terms of extending credit to a customer who was
 * never approved for it at all).
 */
export interface AuthorizedCreditOverride {
  readonly [OVERRIDE_BRAND]: true;
  readonly actorUserId: string;
  readonly reason: string;
}

@Injectable()
export class CreditOverrideAuthorizationService {
  constructor(private readonly policy: PolicyEngine) {}

  authorize(ctx: RequestContext, reason: string | null | undefined): AuthorizedCreditOverride {
    const decision = this.policy.can(ctx, 'customers:credit:override');
    if (!decision.allowed) {
      throw new ForbiddenError(
        `credit-limit override denied (${decision.reason})`,
        'CREDIT_OVERRIDE_DENIED',
      );
    }
    const trimmedReason = reason?.trim() ?? '';
    if (trimmedReason.length === 0) {
      throw new DomainError(
        'CREDIT_OVERRIDE_REASON_REQUIRED',
        'a non-empty reason is required to override a credit-limit denial',
        422,
      );
    }
    if (trimmedReason.length > CREDIT_OVERRIDE_REASON_MAX_LENGTH) {
      throw new DomainError(
        'CREDIT_OVERRIDE_REASON_TOO_LONG',
        `reason must be at most ${CREDIT_OVERRIDE_REASON_MAX_LENGTH} characters`,
        422,
      );
    }
    if (!ctx.userId) {
      // structurally unreachable once `decision.allowed` is true for a
      // TENANT-realm ctx (permission resolution requires a userId) — kept as
      // an explicit fail-closed backstop, never silently defaulted.
      throw new DomainError(
        'CREDIT_OVERRIDE_ACTOR_REQUIRED',
        'an authenticated user is required to override a credit-limit denial',
        422,
      );
    }
    return { [OVERRIDE_BRAND]: true, actorUserId: ctx.userId, reason: trimmedReason };
  }
}

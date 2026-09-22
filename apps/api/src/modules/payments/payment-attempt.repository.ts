import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { getContext, requireTenantContext } from '../../common/context/index.js';
import { rootLogger } from '../../common/logger/logger.js';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  PaymentAttemptReservationRepository,
  type ReservedAsyncAttempt,
} from './payment-attempt-reservation.repository.js';
import { ProviderConfigRepository } from './provider-config.repository.js';
import { PaymentProviderRegistry } from './payment-provider-registry.js';
import {
  isValidPaymentProviderInitiationState,
  type PaymentProviderInitiationState,
} from './payment-provider.port.js';
import type { TenderMethod } from './tender.js';

export interface CreateAsyncPaymentAttemptInput {
  companyId: string;
  branchId: string;
  invoiceId: string;
  method: TenderMethod;
  amountMinor: bigint;
  providerKey: string;
  idempotencyKey: string;
}

export interface AsyncPaymentAttemptResult {
  paymentAttemptId: string;
  invoiceId: string;
  method: TenderMethod;
  providerKey: string;
  amountMinor: bigint;
  currencyCode: string;
  currencyExponent: number;
  state: string;
}

function toResult(attempt: ReservedAsyncAttempt): AsyncPaymentAttemptResult {
  return {
    paymentAttemptId: attempt.paymentAttemptId,
    invoiceId: attempt.invoiceId,
    method: attempt.method,
    providerKey: attempt.providerKey,
    amountMinor: attempt.amountMinor,
    currencyCode: attempt.currencyCode,
    currencyExponent: attempt.currencyExponent,
    state: attempt.state,
  };
}

/** Bounded, safe — never a raw adapter/DB exception message (owner
 *  recovery-pass §4: "Do NOT return provider exception details"). Carries
 *  the attempt id via `DomainError.details` (the only structured extension
 *  point the shared error envelope offers) so a client/operator can track
 *  or later poll this specific reservation. */
function outcomeUnknown(paymentAttemptId: string): DomainError {
  return new DomainError(
    'PAYMENT_PROVIDER_OUTCOME_UNKNOWN',
    'the payment provider outcome for this attempt could not be confirmed — retry with the same Idempotency-Key',
    409,
    [{ field: 'paymentAttemptId', issue: paymentAttemptId }],
  );
}

/**
 * Task 3b.5 Checkpoint E (owner recovery pass) — orchestrates the async
 * PaymentAttempt flow. Two-phase shape (owner §E8/§E11/§E14), now with an
 * explicit recovery path so a durably-reserved attempt is never permanently
 * stranded:
 *
 *   1. RECOVERY DISCOVERY — a cheap, lock-free lookup by
 *      `(tenantId, createdByUserId, idempotencyKey)`, verified against this
 *      request's own semantic identity (owner recovery-pass §6). Runs
 *      BEFORE any config resolution or reservation write.
 *   2. if nothing was found: resolve the provider config fresh (§E5/§E6)
 *      and run PHASE 1 (reserve — its own transaction, commits before any
 *      provider call; race-safe against a concurrent identical retry).
 *   3. if the (found-or-just-created) attempt is `reused` and already past
 *      PENDING, its provider-initiation result was already durably applied
 *      — return it as a normal successful response; the provider is NEVER
 *      called again for it (owner recovery-pass §5).
 *   4. if it is `reused` and still PENDING, this is a genuine crash/ambiguous
 *      recovery (owner recovery-pass §3): re-verify its ORIGINAL
 *      `providerCredentialId` is still usable (never rebind to a
 *      currently-active-but-different config, owner recovery-pass §7), then
 *      retry provider initiation using that SAME attempt identity — the
 *      generic port's retry-safety contract (`payment-provider.port.ts`)
 *      makes this safe.
 *   5. the external provider call — strictly OUTSIDE any transaction
 *      (§E8/§E11). An adapter exception or a malformed/disallowed result
 *      (§E12) is bounded and THROWN as `PAYMENT_PROVIDER_OUTCOME_UNKNOWN`
 *      (owner recovery-pass §4) — never silently downgraded to a cached
 *      2xx, so the shared idempotency claim is released and a retry can
 *      recover this SAME attempt via step 1.
 *   6. PHASE 2 — apply the provider's result in a NEW transaction, opened
 *      only after the call above returned. A persistence failure here is
 *      likewise thrown as `PAYMENT_PROVIDER_OUTCOME_UNKNOWN` rather than
 *      swallowed (owner recovery-pass §4/§8) — Phase 1's reservation is
 *      untouched either way, so this is always safe to retry.
 */
@Injectable()
export class PaymentAttemptRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly reservation: PaymentAttemptReservationRepository,
    private readonly providerConfig: ProviderConfigRepository,
    private readonly registry: PaymentProviderRegistry,
  ) {
    super(db);
  }

  async createAsyncAttemptForBranchScoped(
    input: CreateAsyncPaymentAttemptInput,
  ): Promise<AsyncPaymentAttemptResult> {
    const { tenantId } = requireTenantContext();
    const actorUserId = getContext()?.userId ?? null;

    // ── STEP 1 — recovery discovery, before any config resolution or lock
    //    (owner recovery-pass §3/§6). ──────────────────────────────────────
    let reserved = await this.scoped((tx) =>
      this.reservation.findExistingForRecoveryInTx(tx, {
        tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        invoiceId: input.invoiceId,
        method: input.method,
        amountMinor: input.amountMinor,
        providerKey: input.providerKey,
        createdByUserId: actorUserId,
        idempotencyKey: input.idempotencyKey,
      }),
    );

    if (!reserved) {
      // ── nothing to recover — resolve provider config fresh (§E5/§E6:
      //    trusted scope only, never a client-supplied credential id) and
      //    run PHASE 1. May still discover a `reused` row here (a
      //    concurrent identical retry won the race) — handled uniformly
      //    below regardless of which step found it. ───────────────────────
      const config = await this.providerConfig.resolveForBranchScoped(
        input.companyId,
        input.branchId,
        input.providerKey,
      );
      reserved = await this.scoped((tx) =>
        this.reservation.reserveAsyncAttemptInTx(tx, {
          tenantId,
          companyId: input.companyId,
          branchId: input.branchId,
          invoiceId: input.invoiceId,
          method: input.method,
          amountMinor: input.amountMinor,
          providerKey: input.providerKey,
          providerCredentialId: config.providerCredentialId,
          createdByUserId: actorUserId,
          actingUserId: actorUserId,
          idempotencyKey: input.idempotencyKey,
        }),
      );
    }

    if (reserved.reused) {
      if (reserved.state !== 'PENDING') {
        // already durably resolved by an earlier (partial or complete) run
        // — normal successful response; the provider is NOT called again
        // (owner recovery-pass §5).
        return toResult(reserved);
      }
      // still PENDING — a genuine crash/ambiguous recovery. Never rebind to
      // a currently-active-but-different config (owner recovery-pass §7):
      // re-verify the ATTEMPT'S OWN original credential specifically.
      const stillUsable = await this.providerConfig.verifyCredentialStillUsable(
        reserved.providerCredentialId,
        { companyId: input.companyId, branchId: input.branchId },
      );
      if (!stillUsable) {
        rootLogger.error(
          { paymentAttemptId: reserved.paymentAttemptId },
          'payment-attempt: original provider credential is no longer usable for recovery — reservation left visible for operational reconciliation',
        );
        throw new DomainError(
          'PAYMENT_PROVIDER_CREDENTIAL_UNAVAILABLE',
          'the original payment provider configuration for this attempt is no longer usable — this reservation remains active and requires operational reconciliation',
          409,
          [{ field: 'paymentAttemptId', issue: reserved.paymentAttemptId }],
        );
      }
    }

    // ── external call, strictly outside any DB transaction (§E8/§E11).
    //    Uses `reserved`'s OWN identity throughout — for a brand-new
    //    attempt this is the freshly-resolved credential; for a recovered
    //    one it is the ORIGINAL credential, never a re-resolved one. ──────
    const adapter = this.registry.resolve(reserved.providerKey);
    let outcome: { state: PaymentProviderInitiationState; providerReference: string | null };
    try {
      const initiation = await adapter.createIntent({
        paymentAttemptId: reserved.paymentAttemptId,
        idempotencyKey: input.idempotencyKey,
        amountMinor: reserved.amountMinor,
        currencyCode: reserved.currencyCode,
        currencyExponent: reserved.currencyExponent,
        providerCredentialId: reserved.providerCredentialId,
      });
      // runtime guard (§E12) — a malformed/misbehaving adapter returning
      // `CAPTURED` or any other non-allow-listed value is treated exactly
      // like an ambiguous outcome: fail closed, keep the reservation safe.
      if (!isValidPaymentProviderInitiationState(initiation.state)) {
        rootLogger.error(
          { paymentAttemptId: reserved.paymentAttemptId, state: initiation.state },
          'payment-attempt: provider adapter returned a disallowed initiation state — treating as an unknown outcome',
        );
        throw outcomeUnknown(reserved.paymentAttemptId);
      }
      outcome = {
        state: initiation.state,
        providerReference: initiation.providerReference ?? null,
      };
    } catch (err) {
      if (err instanceof DomainError) throw err;
      // ambiguous transport/adapter failure (§E16/owner recovery-pass §4) —
      // the reservation stays exactly as it was (PENDING, active); the
      // caller must retry with the SAME Idempotency-Key to recover it via
      // STEP 1 above.
      rootLogger.warn(
        { err, paymentAttemptId: reserved.paymentAttemptId },
        'payment-attempt: provider initiation call failed — attempt remains PENDING, retryable',
      );
      throw outcomeUnknown(reserved.paymentAttemptId);
    }

    // ── PHASE 2 — a NEW transaction, opened only after the call above has
    //    already returned. A failure here (owner recovery-pass §4/§8) is
    //    thrown, not swallowed — Phase 1's reservation is untouched either
    //    way, so a retry is always safe and recovers via STEP 1. ──────────
    try {
      const applied = await this.scoped((tx) =>
        this.reservation.applyProviderInitiationResultInTx(tx, {
          tenantId,
          companyId: input.companyId,
          branchId: input.branchId,
          paymentAttemptId: reserved.paymentAttemptId,
          invoiceId: reserved.invoiceId,
          resultState: outcome.state,
          providerReference: outcome.providerReference,
        }),
      );
      return {
        paymentAttemptId: applied.paymentAttemptId,
        invoiceId: reserved.invoiceId,
        method: reserved.method,
        providerKey: reserved.providerKey,
        amountMinor: reserved.amountMinor,
        currencyCode: reserved.currencyCode,
        currencyExponent: reserved.currencyExponent,
        state: applied.state,
      };
    } catch (err) {
      rootLogger.error(
        { err, paymentAttemptId: reserved.paymentAttemptId },
        'payment-attempt: failed to persist the provider initiation result — attempt remains PENDING, retryable',
      );
      throw outcomeUnknown(reserved.paymentAttemptId);
    }
  }
}

import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { SemanticFingerprintProvider } from '../../common/idempotency/index.js';
import { getContext } from '../../common/context/index.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { createCustomerSchema } from './dto/create-customer.dto.js';
import { normalizePhoneE164, normalizeEmail } from './normalization.js';
import { CustomerRepository } from './customer.repository.js';

/**
 * Task 3b.2 owner review round — the Customer-create idempotency fingerprint
 * must be based on NORMALIZED canonical semantics, not the raw HTTP body, so
 * two raw phone inputs that normalize to the same E.164 value (or two email
 * inputs differing only in case/whitespace) produce the SAME fingerprint
 * under the same Idempotency-Key.
 *
 * This class is the Customer module's own opt-in implementation of the
 * generic `SemanticFingerprintProvider` extension point — the shared
 * `IdempotencyInterceptor`/`idempotent.decorator.ts` know nothing about this
 * class or about Customer at all (wired only via `@Idempotent({
 * semanticFingerprintProvider: CustomerCreateFingerprintProvider })` on the
 * create route, resolved app-wide at request time via `ModuleRef`).
 *
 * SECURITY: `tenantId` comes ONLY from `getContext()` (the authenticated
 * server-side session), never from the request. `companyId` comes from the
 * route param — by the time any interceptor runs, `PermissionGuard`
 * (registered as `APP_GUARD`, confirmed) has ALREADY enforced
 * `@ScopedParam({ company: 'companyId' })` for this exact request, so this
 * value is already authorization-validated, not merely path-shaped.
 * `Company.countryCode` is read via the same tenant+company-scoped query the
 * domain create flow itself uses (`CustomerRepository.getCompanyCountryCodeScoped`)
 * — never a client-supplied region, never a UAE/browser-locale/Branch-timezone/
 * accountingTimezone fallback (enforced by `normalizePhoneE164` itself).
 *
 * NORMALIZATION REUSE: calls the exact same `normalizePhoneE164`/
 * `normalizeEmail` functions the domain create/update flow already uses —
 * zero duplicated logic.
 *
 * FAILURE BEHAVIOR: `computeSemanticBody` re-validates the raw body with the
 * SAME `createCustomerSchema` the DTO pipe will apply later, and lets
 * `normalizePhoneE164`'s own `DomainError` (invalid phone) or a schema
 * validation failure propagate as-is. The interceptor awaits this BEFORE
 * calling `resolve()` (which is what actually acquires an idempotency claim)
 * — so a request that fails validation here never creates or poisons an
 * idempotency-store row; it fails exactly as it would via the ordinary DTO
 * pipe, just slightly earlier in the pipeline.
 *
 * PII SAFETY: the returned object is fed ONLY into `requestHash`'s existing
 * `canonicalize()` + SHA-256 pipeline (`canonical-hash.ts`) — it is never
 * logged and never persisted as raw JSON; only the resulting hex digest
 * reaches `idempotency_key.requestHash` (unchanged storage column/behavior).
 */
@Injectable()
export class CustomerCreateFingerprintProvider implements SemanticFingerprintProvider {
  constructor(private readonly customers: CustomerRepository) {}

  async computeSemanticBody(req: FastifyRequest): Promise<unknown> {
    const { tenantId } = getContext() ?? {};
    if (!tenantId) {
      throw new DomainError(
        'IDEMPOTENCY_MISCONFIGURED',
        'idempotency requires an authenticated tenant user',
        500,
      );
    }
    const companyId = (req.params as Record<string, string> | undefined)?.['companyId'];
    if (!companyId) {
      throw new DomainError(
        'CUSTOMER_COMPANY_ID_MISSING',
        'companyId path parameter is required',
        400,
      );
    }

    const parsed = createCustomerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', 'invalid customer create request body', 400, [
        { field: 'body', issue: parsed.error.message },
      ]);
    }

    const countryCode = await this.customers.getCompanyCountryCodeScoped(companyId);
    const phoneE164 = normalizePhoneE164(parsed.data.phone ?? null, countryCode);
    const emailNormalized = normalizeEmail(parsed.data.email ?? null);

    return {
      tenantId,
      companyId,
      displayName: parsed.data.displayName,
      phoneE164,
      emailNormalized,
    };
  }
}

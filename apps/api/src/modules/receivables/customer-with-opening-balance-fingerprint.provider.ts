import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { SemanticFingerprintProvider } from '../../common/idempotency/index.js';
import { getContext } from '../../common/context/index.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { CustomerRepository } from '../customers/customer.repository.js';
import { normalizePhoneE164, normalizeEmail } from '../customers/normalization.js';
import { createCustomerWithOpeningBalanceSchema } from './dto/create-customer-with-opening-balance.dto.js';

/**
 * Task 3b.6 Checkpoint F (F22/F37.5-6) — this route's own semantic
 * idempotency fingerprint, mirroring `CustomerCreateFingerprintProvider`
 * exactly (same tenantId/companyId/normalization/PII-safety rationale — see
 * that class's own doc comment) with ONE addition: `branchId` (the trusted
 * route param) and the `openingBalance` fields (when present) are folded
 * into the hashed semantic body, so "same key + changed opening-balance
 * payload" conflicts (`IDEMPOTENCY_KEY_REUSED`) exactly like every other
 * changed-payload case in this checkpoint chain — never silently replayed
 * against a different financial amount/type/date/note.
 */
@Injectable()
export class CustomerWithOpeningBalanceFingerprintProvider implements SemanticFingerprintProvider {
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
    const params = req.params as Record<string, string> | undefined;
    const companyId = params?.['companyId'];
    const branchId = params?.['branchId'];
    if (!companyId || !branchId) {
      throw new DomainError(
        'CUSTOMER_COMPANY_ID_MISSING',
        'companyId/branchId path parameters are required',
        400,
      );
    }

    const parsed = createCustomerWithOpeningBalanceSchema.safeParse(req.body);
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
      branchId,
      displayName: parsed.data.displayName,
      phoneE164,
      emailNormalized,
      openingBalance: parsed.data.openingBalance ?? null,
    };
  }
}

/**
 * Task 3b.5 Checkpoint A — the frozen tender vocabulary + provider-backed
 * classification. Pure. NO DB, NO provider lookup, NO HTTP.
 *
 * `CREDIT` is forbidden as a tender (frozen rule, owner contract round 1:
 * "Credit is NOT a payment method"). No customer-credit/advance/wallet/
 * store-credit/loyalty/refund tender is ever added to this vocabulary —
 * those are separate domain concepts owned by later tasks (ADR-0019).
 */
export type TenderMethod =
  'CASH' | 'CARD_TERMINAL' | 'BANK_TRANSFER' | 'ONLINE_GATEWAY' | 'OTHER_MANUAL';

export const TENDER_METHODS: readonly TenderMethod[] = Object.freeze([
  'CASH',
  'CARD_TERMINAL',
  'BANK_TRANSFER',
  'ONLINE_GATEWAY',
  'OTHER_MANUAL',
]);

export function isTenderMethod(value: string): value is TenderMethod {
  return (TENDER_METHODS as readonly string[]).includes(value);
}

/**
 * Frozen classification (owner contract round 3, §2):
 *   - `ONLINE_GATEWAY` is always provider-backed.
 *   - `CARD_TERMINAL` is provider-backed ONLY when a `providerCredentialId`
 *     is actually present (an integrated/networked terminal) — a bare manual
 *     terminal slip (no provider credential) is local.
 *   - `CASH` / `BANK_TRANSFER` / `OTHER_MANUAL` are always local/non-provider
 *     in 3b.5.
 *
 * Pure classification only — this never performs a provider/credential
 * lookup; the caller supplies whatever `providerCredentialId` it already
 * has (or `null`).
 */
export function isProviderBackedTender(
  method: TenderMethod,
  providerCredentialId: string | null,
): boolean {
  if (method === 'ONLINE_GATEWAY') return true;
  if (method === 'CARD_TERMINAL') return providerCredentialId !== null;
  return false;
}

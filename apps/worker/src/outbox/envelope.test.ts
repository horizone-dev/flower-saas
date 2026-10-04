import { describe, it, expect } from 'vitest';
import { buildEnvelope, streamKey, ENVELOPE_FIELD, type OutboxRow } from './envelope.js';

const baseRow = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: '01930000-0000-7000-8000-000000000001',
  tenantId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  companyId: null,
  branchId: null,
  aggregateType: 'tenant',
  aggregateId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  eventType: 'tenant.provisioned',
  resourceVersion: null,
  actorSummary: null,
  createdAt: new Date('2026-09-04T12:00:00.000Z'),
  seq: 3n,
  attempts: 0,
  ...over,
});

describe('buildEnvelope', () => {
  it('maps a stamped row onto the ADR-0017 §3 envelope (snake_case, stringified bigints)', () => {
    const env = buildEnvelope(baseRow());
    expect(env).toEqual({
      event_id: '01930000-0000-7000-8000-000000000001',
      seq: '3',
      tenant_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      company_id: null,
      branch_id: null,
      type: 'tenant.provisioned',
      resource_type: 'tenant',
      resource_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      resource_version: null,
      occurred_at: '2026-09-04T12:00:00.000Z',
      actor_summary: null,
    });
  });

  it('carries company_id / branch_id / resource_version / actor_summary when the row has them', () => {
    const env = buildEnvelope(
      baseRow({
        companyId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
        branchId: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
        resourceVersion: 42n,
        actorSummary: { userId: 'u1', accountType: 'OWNER' },
      }),
    );
    expect(env.company_id).toBe('cccccccc-cccc-7ccc-8ccc-cccccccccccc');
    expect(env.branch_id).toBe('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb');
    expect(env.resource_version).toBe('42');
    expect(env.actor_summary).toEqual({ userId: 'u1', accountType: 'OWNER' });
  });

  it('never includes a payload field — the envelope is a change signal only (constraint 5)', () => {
    const rowWithPayload = { ...baseRow(), payload: { secret: 'sk_live_should_never_appear' } };
    const env = buildEnvelope(rowWithPayload as OutboxRow);
    expect(JSON.stringify(env)).not.toContain('sk_live_should_never_appear');
    expect(Object.keys(env).sort()).toEqual(
      [
        'actor_summary',
        'branch_id',
        'company_id',
        'event_id',
        'occurred_at',
        'resource_id',
        'resource_type',
        'resource_version',
        'seq',
        'tenant_id',
        'type',
      ].sort(),
    );
  });

  it('throws if seq is not yet stamped (a caller bug, never a valid publish attempt)', () => {
    expect(() => buildEnvelope(baseRow({ seq: null }))).toThrow(/no seq/);
  });

  it('throws if tenantId is null (the dispatcher is tenant-scoped only)', () => {
    expect(() => buildEnvelope(baseRow({ tenantId: null }))).toThrow(/no tenantId/);
  });
});

describe('streamKey', () => {
  it('is rt:stream:{tenantId} — one durable stream per tenant (OD-P2-4)', () => {
    expect(streamKey('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa')).toBe(
      'rt:stream:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
    );
  });
});

describe('ENVELOPE_FIELD', () => {
  it('is a stable field name', () => {
    expect(ENVELOPE_FIELD).toBe('event');
  });
});

// ── task 3b.9 Checkpoint E — `orders.sale_completed` ─────────────────────────────────────
// The dispatcher relays ANY event type generically (there is no event-type allow-list). This
// pins that a row shaped exactly as the sale facade writes it — tenant + company + branch,
// aggregate `order`, the post-issuance version — builds the right envelope, and that the
// bounded business payload (orderId / invoiceId) is never copied into the realtime envelope.
describe('buildEnvelope — an orders.sale_completed row', () => {
  it('carries the scope, the order resource and its version, and never the payload', () => {
    const row = {
      ...baseRow({
        companyId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
        branchId: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
        aggregateType: 'order',
        aggregateId: '01930000-0000-7000-8000-0000000000aa',
        eventType: 'orders.sale_completed',
        resourceVersion: 2n,
      }),
      payload: { orderId: 'o-1', invoiceId: 'inv-should-not-be-relayed' },
    };
    const env = buildEnvelope(row as OutboxRow);
    expect(env).toMatchObject({
      tenant_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      company_id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
      branch_id: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
      type: 'orders.sale_completed',
      resource_type: 'order',
      resource_id: '01930000-0000-7000-8000-0000000000aa',
      resource_version: '2',
    });
    expect(JSON.stringify(env)).not.toContain('inv-should-not-be-relayed');
  });
});

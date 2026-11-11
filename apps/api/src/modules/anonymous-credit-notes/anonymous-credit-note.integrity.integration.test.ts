import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { startTestStack, migrateTestDb, type TestStack } from '@flower/testing';
import { SystemClock } from '../../common/clock/clock.js';
import {
  createSaleWorld,
  mintTenantToken,
  rolePerms,
  type Co,
  type SaleWorld,
} from '../../verification/load-sale-world.js';

/**
 * Phase 3B closure — F-4 DATABASE INTEGRITY. The status of a refund and its accounting posting must never diverge. This file proves, on
 * real PostgreSQL with all 50 migrations:
 *   1. WHO can write — every role's exact privilege on the three tables, read from the catalog (not assumed);
 *   2. the deferred commit-time guards reject a status without its journal, a journal of the WRONG shape, and a posting for a refund that
 *      posts nothing — for the application role, for a superuser with triggers on, and for the platform realm;
 *   3. the guards ACCEPT the genuine shape (so they are a check, not a wall that breaks the application);
 *   4. the application keeps status + posting + audit atomic (a closed period rolls the whole execution back; concurrent executions
 *      produce exactly one journal);
 *   5. the one residual path — a superuser disabling triggers — is made VISIBLE by the reconciliation control (Q3).
 */
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => v as Json;
const str = (v: unknown): string => String(v);

describe('anonymous credit note — F-4 status ↔ posting integrity (real PostgreSQL)', () => {
  let stack: TestStack;
  let w: SaleWorld;
  let admin: pg.Pool;
  let co: Co;
  let branch: string;
  let manager = '';
  let counter = 0;
  const key = (p: string): string => `${p}-${++counter}-${randomUUID().slice(0, 8)}`;
  const rows = async <T extends Json = Json>(sql: string, p: unknown[] = []): Promise<T[]> =>
    (await admin.query(sql, p)).rows as T[];
  const base = (): string => `/companies/${co.companyId}/branches/${branch}`;
  /** the accountant's control queries (docs/phase-3/RB-1-ACCOUNTANT-CONTROL-QUERIES.sql), unchanged apart from the company placeholder */
  const controlQueries = (): { name: string; sql: string }[] =>
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../../docs/phase-3/RB-1-ACCOUNTANT-CONTROL-QUERIES.sql',
      ),
      'utf8',
    )
      .split(/^-- @query /m)
      .slice(1)
      .map((chunk) => ({
        name: chunk.split('\n', 1)[0]!.trim(),
        sql: chunk
          .slice(chunk.indexOf('\n') + 1)
          .split('\n')
          .filter((l) => !l.trim().startsWith('--'))
          .join('\n')
          .trim()
          .replace(/;$/, '')
          .replaceAll(":'company_id'", '$1'),
      }));

  interface Sale {
    invoiceId: string;
    orderId: string;
    lineIds: string[];
    subtotal: bigint;
    tax: bigint;
    total: bigint;
  }
  async function sell(
    split?: (t: bigint) => { method: string; amountMinor: bigint }[],
  ): Promise<Sale> {
    const created = await w.req(
      'POST',
      `${base()}/orders`,
      w.ownerToken,
      {
        lines: [
          {
            productId: w.productId,
            variantId: w.variantId,
            selectedUomCode: 'piece',
            quantity: '3',
          },
        ],
      },
      { 'idempotency-key': key('order') },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = obj(obj(created.body)['order']) as { id: string; version: number };
    const prev = await w.req('GET', `${base()}/orders/${order.id}/totals`, w.ownerToken);
    const total = BigInt(str(obj(prev.body)['totalAmountMinor']));
    const tenders = (split ?? ((t) => [{ method: 'CASH', amountMinor: t }]))(total);
    const done = await w.req(
      'POST',
      `${base()}/orders/${order.id}/complete-sale`,
      w.ownerToken,
      {
        paymentIntent: 'PAY_NOW',
        tenders: tenders.map((t) => ({ method: t.method, amountMinor: t.amountMinor.toString() })),
      },
      { 'if-match': String(order.version), 'idempotency-key': key('sale') },
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const inv = obj(obj(done.body)['invoice']);
    const lineIds = (
      await rows<{ id: string }>(
        `SELECT id FROM order_line WHERE "orderId" = $1 ORDER BY "linePosition"`,
        [order.id],
      )
    ).map((r) => r.id);
    return {
      invoiceId: str(inv['id']),
      orderId: order.id,
      lineIds,
      subtotal: BigInt(str(inv['subtotalAmountMinor'])),
      tax: BigInt(str(inv['taxTotalAmountMinor'])),
      total: BigInt(str(inv['totalAmountMinor'])),
    };
  }
  async function issue(s: Sale, refunds: { method: string; amountMinor: bigint }[]) {
    const r = await w.req(
      'POST',
      `${base()}/invoices/${s.invoiceId}/anonymous-credit-notes`,
      manager,
      {
        reasonCode: 'CUSTOMER_REQUEST',
        lines: s.lineIds.map((id) => ({ orderLineId: id, quantity: '3' })),
        refunds: refunds.map((x) => ({ method: x.method, amountMinor: x.amountMinor.toString() })),
      },
      { 'idempotency-key': key('cn') },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return obj(r.body);
  }
  const execUrl = (noteId: string, refundId: string): string =>
    `${base()}/anonymous-credit-notes/${noteId}/refunds/${refundId}/execute`;
  const refundOf = (note: Json, method: string): Json =>
    (note['refunds'] as Json[]).find((r) => r['method'] === method)!;

  /** run `fn` as the given role, with the tenant GUC set, inside ONE transaction on a fresh connection; resolves to the error message or 'OK' */
  async function asRole(
    role: string | null,
    tenantId: string | null,
    fn: (c: pg.PoolClient) => Promise<void>,
    opts: { replica?: boolean } = {},
  ): Promise<string> {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      if (opts.replica) await c.query(`SET LOCAL session_replication_role = replica`);
      if (role) await c.query(`SET LOCAL ROLE "${role}"`);
      if (tenantId) await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await fn(c);
      await c.query('COMMIT');
      return 'OK';
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch {
        /* the connection is released below */
      }
      return (e as Error).message;
    } finally {
      c.release();
    }
  }

  /** a raw, balanced, sealed journal for (sourceKind, sourceId) — built with the frozen journal triggers ON */
  async function rawJournal(
    c: pg.PoolClient,
    sourceKind: string,
    sourceId: string,
    lines: { key: string; dr: bigint; cr: bigint }[],
  ): Promise<void> {
    const je = randomUUID();
    await c.query(
      `INSERT INTO journal_entry (id,"tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId","currencyCode","postingFingerprint")
       VALUES ($1,$2,$3,(SELECT id FROM accounting_period WHERE "companyId" = $3 AND status = 'OPEN' ORDER BY "startDate" DESC LIMIT 1),
               (SELECT max("postingDate") FROM journal_entry WHERE "companyId" = $3),$4,$5,'AED',$6)`,
      [je, co.tenantId, co.companyId, sourceKind, sourceId, `fp-${je}`],
    );
    for (const l of lines) {
      await c.query(
        `INSERT INTO journal_line (id,"tenantId","companyId","journalEntryId","accountId","branchId","debitMinor","creditMinor")
         VALUES (uuidv7(),$1,$2,$3,(SELECT id FROM account WHERE "companyId" = $2 AND key = $4),$5,$6,$7)`,
        [co.tenantId, co.companyId, je, l.key, branch, l.dr.toString(), l.cr.toString()],
      );
    }
    await c.query(`UPDATE journal_entry SET "sealedAt" = now() WHERE id = $1`, [je]);
  }
  const markExecuted = (c: pg.PoolClient, refundId: string) =>
    c.query(
      `UPDATE anonymous_credit_note_refund SET status = 'EXECUTED', "resolvedAt" = now(), "resolvedByUserId" = gen_random_uuid() WHERE id = $1`,
      [refundId],
    );
  const statusOf = async (refundId: string): Promise<string> =>
    str(
      (await rows(`SELECT status FROM anonymous_credit_note_refund WHERE id = $1`, [refundId]))[0]![
        'status'
      ],
    );

  beforeAll(async () => {
    stack = await startTestStack({ services: ['postgres', 'redis'] });
    migrateTestDb(stack.postgres.url);
    admin = new pg.Pool({ connectionString: stack.postgres.url, max: 4 });
    w = await createSaleWorld({ pg: stack.postgres.url, redis: stack.redis.url }, 3);
    co = w.a;
    branch = co.branches[0]!;
    manager = await mintTenantToken(w.h, co.tenantId, rolePerms('manager'), { stepUp: true });
  }, 600_000);

  afterAll(async () => {
    await w?.h.app.close();
    await w?.pool?.end();
    await admin?.end();
    await stack?.stop();
  });

  // ═══════════════════════════ 1. who can write — read from the catalog ═══════════════════════════
  it('ROLE INVENTORY: exactly which roles can write the three tables and the refund status, from pg catalog — the application role only (RLS-bound), the platform realm read-only', async () => {
    const tables = [
      'anonymous_credit_note',
      'anonymous_credit_note_line',
      'anonymous_credit_note_refund',
    ];
    const roles = await rows<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'flower\\_%' OR rolsuper ORDER BY 1`,
    );
    const names = roles.map((r) => r.rolname);
    expect(names).toEqual(
      expect.arrayContaining(['flower_app', 'flower_platform', 'flower_migrate']),
    );
    const priv = async (role: string, table: string, p: string): Promise<boolean> =>
      (
        await rows<{ ok: boolean }>(`SELECT has_table_privilege($1, $2, $3) AS ok`, [
          role,
          table,
          p,
        ])
      )[0]!.ok;
    const colPriv = async (role: string, table: string, col: string): Promise<boolean> =>
      (
        await rows<{ ok: boolean }>(`SELECT has_column_privilege($1, $2, $3, 'UPDATE') AS ok`, [
          role,
          table,
          col,
        ])
      )[0]!.ok;

    // the application role: SELECT + INSERT; never DELETE / TRUNCATE; UPDATE only the six outcome columns of the refund table
    for (const t of tables) {
      expect(await priv('flower_app', t, 'SELECT'), `app SELECT ${t}`).toBe(true);
      expect(await priv('flower_app', t, 'INSERT'), `app INSERT ${t}`).toBe(true);
      expect(await priv('flower_app', t, 'DELETE'), `app DELETE ${t}`).toBe(false);
      expect(await priv('flower_app', t, 'TRUNCATE'), `app TRUNCATE ${t}`).toBe(false);
    }
    for (const t of tables.slice(0, 2)) {
      expect(await colPriv('flower_app', t, 'createdAt'), `app UPDATE ${t}`).toBe(false);
    }
    const refundCols = (
      await rows<{ attname: string }>(
        `SELECT attname FROM pg_attribute WHERE attrelid = 'anonymous_credit_note_refund'::regclass AND attnum > 0 AND NOT attisdropped`,
      )
    ).map((r) => r.attname);
    const updatable: string[] = [];
    for (const c of refundCols)
      if (await colPriv('flower_app', 'anonymous_credit_note_refund', c)) updatable.push(c);
    expect(updatable.sort()).toEqual(
      [
        'failureReasonCode',
        'reference',
        'resolvedAt',
        'resolvedByUserId',
        'status',
        'updatedAt',
      ].sort(),
    );
    // the platform realm (BYPASSRLS, cross-tenant): SELECT only
    for (const t of tables) {
      expect(await priv('flower_platform', t, 'SELECT'), `platform SELECT ${t}`).toBe(true);
      for (const p of ['INSERT', 'DELETE', 'TRUNCATE'])
        expect(await priv('flower_platform', t, p), `platform ${p} ${t}`).toBe(false);
    }
    for (const c of refundCols)
      expect(
        await colPriv('flower_platform', 'anonymous_credit_note_refund', c),
        `platform UPDATE ${c}`,
      ).toBe(false);
    // nobody else: no grant to PUBLIC, no other flower_* role (the outbox dispatcher in particular) holds any privilege
    const publicGrants = await rows(
      `SELECT 1 FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_name = ANY($1)`,
      [tables],
    );
    expect(publicGrants).toHaveLength(0);
    for (const r of names.filter(
      (n) => !['flower_app', 'flower_platform', 'flower_migrate'].includes(n),
    )) {
      const role = roles.find((x) => x.rolname === r)!;
      if (role.rolsuper) continue; // a superuser can do anything — the residual path of §5
      for (const t of tables) expect(await priv(r, t, 'SELECT'), `${r} SELECT ${t}`).toBe(false);
    }
    // everything that CAN update the refund status: the application role, the migration owner and superusers — nothing else
    const canUpdateStatus: string[] = [];
    for (const r of roles) {
      if (await colPriv(r.rolname, 'anonymous_credit_note_refund', 'status'))
        canUpdateStatus.push(r.rolname);
    }
    const supers = roles.filter((r) => r.rolsuper).map((r) => r.rolname);
    expect(canUpdateStatus.sort()).toEqual(
      [...new Set(['flower_app', 'flower_migrate', ...supers])].sort(),
    );
    // the tenant-bound role cannot bypass RLS; only the platform realm and superusers can
    expect(roles.find((r) => r.rolname === 'flower_app')).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
    });
  });

  // ═══════════════════════════ 2. the guards reject every divergence ═══════════════════════════
  it('BYPASS (application role): a direct EXECUTED without its journal is rejected at commit and the refund stays PENDING', async () => {
    const s = await sell();
    const note = await issue(s, [{ method: 'CASH', amountMinor: s.total }]);
    const refundId = str(refundOf(note, 'CASH')['id']);
    const msg = await asRole('flower_app', co.tenantId, (c) =>
      markExecuted(c, refundId).then(() => undefined),
    );
    expect(msg).toMatch(/needs exactly one execution journal/);
    expect(await statusOf(refundId)).toBe('PENDING');
    // the same bypass as a superuser with every trigger ON (not replica) is rejected too
    expect(
      await asRole(null, null, (c) => markExecuted(c, refundId).then(() => undefined)),
    ).toMatch(/needs exactly one execution journal/);
    expect(await statusOf(refundId)).toBe('PENDING');
  });

  it('BYPASS (wrong shape): an execution journal on the WRONG account, the WRONG amount, with an EXTRA line, or on the wrong direction is rejected; the exact genuine shape is accepted', async () => {
    const mk = async () => {
      const s = await sell();
      const note = await issue(s, [{ method: 'CASH', amountMinor: s.total }]);
      return { s, id: str(refundOf(note, 'CASH')['id']) };
    };
    const attempt = async (
      id: string,
      lines: { key: string; dr: bigint; cr: bigint }[],
    ): Promise<string> =>
      asRole(null, null, async (c) => {
        await rawJournal(c, 'anonymous_credit_note_refund', id, lines);
        await markExecuted(c, id);
      });
    const a = await mk();
    expect(
      await attempt(a.id, [
        { key: 'ASSET.PAYMENT_CLEARING', dr: a.s.total, cr: 0n },
        { key: 'ASSET.BANK', dr: 0n, cr: a.s.total }, // BANK instead of CASH_ON_HAND
      ]),
    ).toMatch(/must be sealed and be exactly Dr ASSET.PAYMENT_CLEARING \/ Cr ASSET.CASH_ON_HAND/);
    expect(await statusOf(a.id)).toBe('PENDING');
    expect(
      await attempt(a.id, [
        { key: 'ASSET.PAYMENT_CLEARING', dr: a.s.total - 1n, cr: 0n },
        { key: 'ASSET.CASH_ON_HAND', dr: 0n, cr: a.s.total - 1n }, // one minor unit short
      ]),
    ).toMatch(/exactly Dr ASSET.PAYMENT_CLEARING/);
    expect(
      await attempt(a.id, [
        { key: 'ASSET.PAYMENT_CLEARING', dr: a.s.total, cr: 0n },
        { key: 'ASSET.CASH_ON_HAND', dr: 0n, cr: a.s.total - 1n },
        { key: 'EXPENSE.PAYMENT_PROCESSING_FEE', dr: 0n, cr: 1n }, // an extra, balancing line
      ]),
    ).toMatch(/exactly Dr ASSET.PAYMENT_CLEARING/);
    expect(
      await attempt(a.id, [
        { key: 'ASSET.CASH_ON_HAND', dr: a.s.total, cr: 0n }, // reversed direction (a cash receipt, not a payout)
        { key: 'ASSET.PAYMENT_CLEARING', dr: 0n, cr: a.s.total },
      ]),
    ).toMatch(/exactly Dr ASSET.PAYMENT_CLEARING/);
    expect(await statusOf(a.id)).toBe('PENDING');
    // the exact genuine shape is accepted (the guard is a check, not a wall)
    expect(
      await attempt(a.id, [
        { key: 'ASSET.PAYMENT_CLEARING', dr: a.s.total, cr: 0n },
        { key: 'ASSET.CASH_ON_HAND', dr: 0n, cr: a.s.total },
      ]),
    ).toBe('OK');
    expect(await statusOf(a.id)).toBe('EXECUTED');
    // TRUST ASSUMPTION, MADE DETECTABLE: that genuine-shaped bypass is indistinguishable from the application for the database guard — but it
    // left NO audit record, and control query Q9 (EXECUTED without an audit row of its execution) lists exactly that refund
    const q9 = controlQueries().find((q) => q.name === 'executed_without_audit')!;
    const found = await rows(q9.sql, [co.companyId]);
    expect(found.map((r) => r['refund_id'])).toContain(a.id);
    // …whereas a refund attested through the application has its audit row and never appears
    const b = await mk();
    const ex = await w.req(
      'POST',
      execUrl(
        str(
          (
            await rows(
              `SELECT "creditNoteId" AS c FROM anonymous_credit_note_refund WHERE id = $1`,
              [b.id],
            )
          )[0]!['c'],
        ),
        b.id,
      ),
      manager,
      {},
      { 'idempotency-key': key('ex') },
    );
    expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    expect((await rows(q9.sql, [co.companyId])).map((r) => r['refund_id'])).not.toContain(b.id);
  });

  it('BYPASS (refunds that post nothing): an execution journal for a FAILED refund or for a manual CARD refund is rejected; a manual CARD refund may be EXECUTED with NO journal', async () => {
    const s = await sell((t) => [
      { method: 'CASH', amountMinor: t - 1000n },
      { method: 'CARD_TERMINAL', amountMinor: 1000n },
    ]);
    const note = await issue(s, [
      { method: 'CASH', amountMinor: s.total - 1000n },
      { method: 'CARD_TERMINAL', amountMinor: 1000n },
    ]);
    const cardId = str(refundOf(note, 'CARD_TERMINAL')['id']);
    const cashId = str(refundOf(note, 'CASH')['id']);
    const phantom = [
      { key: 'ASSET.PAYMENT_CLEARING', dr: 1000n, cr: 0n },
      { key: 'ASSET.BANK', dr: 0n, cr: 1000n },
    ];
    // a posting for a manual card refund that must post nothing
    expect(
      await asRole(null, null, async (c) => {
        await rawJournal(c, 'anonymous_credit_note_refund', cardId, phantom);
        await markExecuted(c, cardId);
      }),
    ).toMatch(/posts no execution journal/);
    // a posting for a FAILED cash refund
    expect(
      await asRole(null, null, async (c) => {
        await rawJournal(c, 'anonymous_credit_note_refund', cashId, [
          { key: 'ASSET.PAYMENT_CLEARING', dr: s.total - 1000n, cr: 0n },
          { key: 'ASSET.CASH_ON_HAND', dr: 0n, cr: s.total - 1000n },
        ]);
        await c.query(
          `UPDATE anonymous_credit_note_refund SET status = 'FAILED', "resolvedAt" = now(), "resolvedByUserId" = gen_random_uuid(), "failureReasonCode" = 'OTHER' WHERE id = $1`,
          [cashId],
        );
      }),
    ).toMatch(/posts no execution journal/);
    expect(await statusOf(cashId)).toBe('PENDING');
    // a manual card refund EXECUTED by the application role with no journal is the correct, allowed state
    expect(
      await asRole('flower_app', co.tenantId, (c) => markExecuted(c, cardId).then(() => undefined)),
    ).toBe('OK');
    expect(await statusOf(cardId)).toBe('EXECUTED');
  });

  it('BYPASS (privileges and isolation): the application role cannot change an amount, delete, or insert a refund born EXECUTED; the platform realm cannot write; another tenant cannot touch the row', async () => {
    const s = await sell();
    const note = await issue(s, [{ method: 'CASH', amountMinor: s.total }]);
    const refundId = str(refundOf(note, 'CASH')['id']);
    const noteId = str(note['id']);
    expect(
      await asRole('flower_app', co.tenantId, (c) =>
        c
          .query(`UPDATE anonymous_credit_note_refund SET "amountMinor" = 1 WHERE id = $1`, [
            refundId,
          ])
          .then(() => undefined),
      ),
    ).toMatch(/permission denied/);
    expect(
      await asRole('flower_app', co.tenantId, (c) =>
        c
          .query(`DELETE FROM anonymous_credit_note_refund WHERE id = $1`, [refundId])
          .then(() => undefined),
      ),
    ).toMatch(/permission denied/);
    expect(
      await asRole('flower_app', co.tenantId, (c) =>
        c
          .query(
            `INSERT INTO anonymous_credit_note_refund ("tenantId","companyId","branchId","creditNoteId","invoiceId","method","amountMinor","currencyCode","currencyExponent","status","resolvedAt")
             SELECT "tenantId","companyId","branchId", id, "invoiceId", 'CASH', 1, "currencyCode","currencyExponent", 'EXECUTED', now()
               FROM anonymous_credit_note WHERE id = $1`,
            [noteId],
          )
          .then(() => undefined),
      ),
    ).toMatch(/created PENDING|exceed/);
    // the platform realm (BYPASSRLS) is read-only on these tables
    expect(
      await asRole('flower_platform', null, (c) => markExecuted(c, refundId).then(() => undefined)),
    ).toMatch(/permission denied/);
    expect(
      await asRole('flower_platform', null, async (c) => {
        const r = await c.query(
          `SELECT count(*)::int AS n FROM anonymous_credit_note_refund WHERE id = $1`,
          [refundId],
        );
        expect(r.rows[0].n).toBe(1);
      }),
    ).toBe('OK');
    // another tenant: RLS hides the row, so the UPDATE touches nothing
    const foreign = w.b.tenantId;
    expect(foreign).not.toBe(co.tenantId);
    expect(
      await asRole('flower_app', foreign, async (c) => {
        const r = await c.query(
          `UPDATE anonymous_credit_note_refund SET status = 'FAILED', "resolvedAt" = now(), "resolvedByUserId" = gen_random_uuid(), "failureReasonCode" = 'OTHER' WHERE id = $1`,
          [refundId],
        );
        expect(r.rowCount).toBe(0);
      }),
    ).toBe('OK');
    expect(await statusOf(refundId)).toBe('PENDING');
  });

  it('ISSUANCE: a credit note cannot commit without its issuance journal, nor with a wrong one; the exact journal is accepted', async () => {
    const s = await sell();
    const noteId = randomUUID();
    const insertNote = async (c: pg.PoolClient, number: string): Promise<void> => {
      await c.query(
        `INSERT INTO anonymous_credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor")
         SELECT $1,i."tenantId",i."companyId",i."branchId",i.id,$2,now(),(SELECT max("postingDate") FROM journal_entry WHERE "companyId" = i."companyId"),i."currencyCode",i."currencyExponent",'OTHER',$3,$4,$5
           FROM invoice i WHERE i.id = $6`,
        [noteId, number, s.subtotal.toString(), s.tax.toString(), s.total.toString(), s.invoiceId],
      );
      await c.query(
        `INSERT INTO anonymous_credit_note_line ("tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
         SELECT n."tenantId",n."companyId",n.id,$2,3,$3,0,0,$3,$4,$5,n."currencyCode",n."currencyExponent" FROM anonymous_credit_note n WHERE n.id = $1`,
        [noteId, s.lineIds[0], s.subtotal.toString(), s.tax.toString(), s.total.toString()],
      );
      await c.query(
        `INSERT INTO anonymous_credit_note_refund ("tenantId","companyId","branchId","creditNoteId","invoiceId","method","amountMinor","currencyCode","currencyExponent")
         SELECT n."tenantId",n."companyId",n."branchId",n.id,n."invoiceId",'CASH',$2,n."currencyCode",n."currencyExponent" FROM anonymous_credit_note n WHERE n.id = $1`,
        [noteId, s.total.toString()],
      );
    };
    const genuine = [
      { key: 'REVENUE.SALES', dr: s.total - s.tax, cr: 0n },
      ...(s.tax > 0n ? [{ key: 'LIABILITY.TAX_PAYABLE', dr: s.tax, cr: 0n }] : []),
      { key: 'ASSET.PAYMENT_CLEARING', dr: 0n, cr: s.total },
    ];
    // (a) no journal at all
    expect(await asRole(null, null, (c) => insertNote(c, 'CN-900001'))).toMatch(
      /needs exactly one issuance journal/,
    );
    // (b) a journal whose revenue leg is one unit short (balanced by a larger tax leg) — wrong shape
    expect(
      await asRole(null, null, async (c) => {
        await insertNote(c, 'CN-900002');
        await rawJournal(c, 'anonymous_credit_note', noteId, [
          { key: 'REVENUE.SALES', dr: s.total - s.tax - 1n, cr: 0n },
          { key: 'LIABILITY.TAX_PAYABLE', dr: s.tax + 1n, cr: 0n },
          { key: 'ASSET.PAYMENT_CLEARING', dr: 0n, cr: s.total },
        ]);
      }),
    ).toMatch(/issuance journal must be sealed and be exactly/);
    // (c) the genuine journal is accepted
    expect(
      await asRole(null, null, async (c) => {
        await insertNote(c, 'CN-900003');
        await rawJournal(c, 'anonymous_credit_note', noteId, genuine);
      }),
    ).toBe('OK');
    expect((await rows(`SELECT 1 FROM anonymous_credit_note WHERE id = $1`, [noteId])).length).toBe(
      1,
    );
  });

  // ═══════════════════════════ 2b. forged EVIDENCE: temporary-table shadowing (independent review finding) ═══════════════════════════
  it('SHADOWING: a session cannot fool a guard by creating TEMPORARY tables named journal_entry / journal_line / account with forged rows — the guards read the real schema only', async () => {
    const s = await sell();
    const note = await issue(s, [{ method: 'CASH', amountMinor: s.total }]);
    const refundId = str(refundOf(note, 'CASH')['id']);
    // the attacker: the tenant-bound application role, with its normal TEMP privilege, forging the whole execution journal in temp tables
    const msg = await asRole('flower_app', co.tenantId, async (c) => {
      await c.query(
        `CREATE TEMP TABLE journal_entry ("id" uuid, "tenantId" uuid, "companyId" uuid, "sourceKind" text, "sourceId" text, "sealedAt" timestamptz)`,
      );
      await c.query(
        `CREATE TEMP TABLE journal_line ("journalEntryId" uuid, "accountId" uuid, "debitMinor" bigint, "creditMinor" bigint)`,
      );
      await c.query(`CREATE TEMP TABLE account ("id" uuid, "key" text)`);
      const je = randomUUID();
      const [clearing, cash] = [randomUUID(), randomUUID()];
      await c.query(
        `INSERT INTO pg_temp.account VALUES ($1,'ASSET.PAYMENT_CLEARING'), ($2,'ASSET.CASH_ON_HAND')`,
        [clearing, cash],
      );
      await c.query(
        `INSERT INTO pg_temp.journal_entry VALUES ($1,$2,$3,'anonymous_credit_note_refund',$4,now())`,
        [je, co.tenantId, co.companyId, refundId],
      );
      await c.query(`INSERT INTO pg_temp.journal_line VALUES ($1,$2,$3,0), ($1,$4,0,$3)`, [
        je,
        clearing,
        s.total.toString(),
        cash,
      ]);
      await c.query(
        `UPDATE anonymous_credit_note_refund SET status = 'EXECUTED', "resolvedAt" = now(), "resolvedByUserId" = gen_random_uuid() WHERE id = $1`,
        [refundId],
      );
    });
    expect(msg, 'the guard accepted FORGED temp-table evidence').not.toBe('OK');
    expect(await statusOf(refundId)).toBe('PENDING');
  });

  it('SHADOWING (issuance): forged TEMPORARY journal tables cannot make a credit note commit without its real issuance journal', async () => {
    const s = await sell();
    const noteId = randomUUID();
    const msg = await asRole('flower_app', co.tenantId, async (c) => {
      // the note, its line and its refund, written directly by the tenant-bound role (all table guards pass)
      await c.query(
        `INSERT INTO anonymous_credit_note (id,"tenantId","companyId","branchId","invoiceId","creditNoteNumber","issuedAt","accountingDate","currencyCode","currencyExponent","reasonCode","subtotalAmountMinor","taxTotalAmountMinor","totalAmountMinor")
         SELECT $1,i."tenantId",i."companyId",i."branchId",i.id,'CN-900777',now(),(SELECT max("postingDate") FROM journal_entry WHERE "companyId" = i."companyId"),i."currencyCode",i."currencyExponent",'OTHER',$3,$4,$5
           FROM invoice i WHERE i.id = $2`,
        [noteId, s.invoiceId, s.subtotal.toString(), s.tax.toString(), s.total.toString()],
      );
      await c.query(
        `INSERT INTO anonymous_credit_note_line ("tenantId","companyId","creditNoteId","orderLineId","quantityCredited","grossCreditedMinor","discountCreditedMinor","documentDiscountShareCreditedMinor","netAfterDocumentDiscountCreditedMinor","taxCreditedMinor","lineTotalCreditedMinor","currencyCode","currencyExponent")
         SELECT n."tenantId",n."companyId",n.id,$2,3,$3,0,0,$3,$4,$5,n."currencyCode",n."currencyExponent" FROM anonymous_credit_note n WHERE n.id = $1`,
        [noteId, s.lineIds[0], s.subtotal.toString(), s.tax.toString(), s.total.toString()],
      );
      await c.query(
        `INSERT INTO anonymous_credit_note_refund ("tenantId","companyId","branchId","creditNoteId","invoiceId","method","amountMinor","currencyCode","currencyExponent")
         SELECT n."tenantId",n."companyId",n."branchId",n.id,n."invoiceId",'CASH',$2,n."currencyCode",n."currencyExponent" FROM anonymous_credit_note n WHERE n.id = $1`,
        [noteId, s.total.toString()],
      );
      // the forged evidence: temporary tables shadowing the journal tables, holding an exact issuance journal
      await c.query(
        `CREATE TEMP TABLE journal_entry ("id" uuid, "tenantId" uuid, "companyId" uuid, "sourceKind" text, "sourceId" text, "sealedAt" timestamptz)`,
      );
      await c.query(
        `CREATE TEMP TABLE journal_line ("journalEntryId" uuid, "accountId" uuid, "debitMinor" bigint, "creditMinor" bigint)`,
      );
      await c.query(`CREATE TEMP TABLE account ("id" uuid, "key" text)`);
      const [je, rev, tax, clr] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      await c.query(
        `INSERT INTO pg_temp.account VALUES ($1,'REVENUE.SALES'), ($2,'LIABILITY.TAX_PAYABLE'), ($3,'ASSET.PAYMENT_CLEARING')`,
        [rev, tax, clr],
      );
      await c.query(
        `INSERT INTO pg_temp.journal_entry VALUES ($1,$2,$3,'anonymous_credit_note',$4,now())`,
        [je, co.tenantId, co.companyId, noteId],
      );
      await c.query(
        `INSERT INTO pg_temp.journal_line VALUES ($1,$2,$3,0), ($1,$4,$5,0), ($1,$6,0,$7)`,
        [je, rev, (s.total - s.tax).toString(), tax, s.tax.toString(), clr, s.total.toString()],
      );
    });
    expect(msg, 'the issuance guard accepted FORGED temp-table evidence').not.toBe('OK');
    // …and it was refused BY THE GUARD (not by some unrelated earlier error that would make this test vacuous)
    expect(msg).toMatch(/needs exactly one issuance journal/);
    expect(await rows(`SELECT 1 FROM anonymous_credit_note WHERE id = $1`, [noteId])).toHaveLength(
      0,
    );
  });

  // ═══════════════════════════ 2c. an attestation is always ATTRIBUTED ═══════════════════════════
  it('ATTRIBUTION: an EXECUTED or FAILED refund must name the user who attested it — rejected for the application role and for a superuser; the application never attests anonymously', async () => {
    const s = await sell((t) => [
      { method: 'CASH', amountMinor: t - 1000n },
      { method: 'CARD_TERMINAL', amountMinor: 1000n },
    ]);
    const note = await issue(s, [
      { method: 'CASH', amountMinor: s.total - 1000n },
      { method: 'CARD_TERMINAL', amountMinor: 1000n },
    ]);
    const card = str(refundOf(note, 'CARD_TERMINAL')['id']);
    const cash = str(refundOf(note, 'CASH')['id']);
    // a manual card refund posts no journal, so the attester is the ONLY evidence: no attester → no EXECUTED, however it is written
    const noAttester = (id: string, status: 'EXECUTED' | 'FAILED') => (c: pg.PoolClient) =>
      c
        .query(
          `UPDATE anonymous_credit_note_refund SET status = $2, "resolvedAt" = now()${status === 'FAILED' ? `, "failureReasonCode" = 'OTHER'` : ''} WHERE id = $1`,
          [id, status],
        )
        .then(() => undefined);
    expect(await asRole('flower_app', co.tenantId, noAttester(card, 'EXECUTED'))).toMatch(
      /state_chk|check constraint/,
    );
    expect(await asRole(null, null, noAttester(card, 'EXECUTED'))).toMatch(
      /state_chk|check constraint/,
    );
    expect(await asRole('flower_app', co.tenantId, noAttester(cash, 'FAILED'))).toMatch(
      /state_chk|check constraint/,
    );
    expect(await statusOf(card)).toBe('PENDING');
    // a PENDING row can never carry an attester either (the other direction of the same constraint)
    expect(
      await asRole('flower_app', co.tenantId, (c) =>
        c
          .query(
            `UPDATE anonymous_credit_note_refund SET "resolvedByUserId" = gen_random_uuid() WHERE id = $1`,
            [card],
          )
          .then(() => undefined),
      ),
    ).toMatch(/state_chk|check constraint|only the outcome columns|PENDING refund can only become/);
    // with an attester the manual-card attestation is accepted (and posts nothing)
    expect(
      await asRole('flower_app', co.tenantId, (c) => markExecuted(c, card).then(() => undefined)),
    ).toBe('OK');
    expect(
      (
        await rows<{ by: string | null }>(
          `SELECT "resolvedByUserId"::text AS by FROM anonymous_credit_note_refund WHERE id = $1`,
          [card],
        )
      )[0]!.by,
    ).not.toBeNull();
    // through the application the attester is the authenticated user, always
    const exec = await w.req(
      'POST',
      execUrl(str(note['id']), cash),
      manager,
      {},
      { 'idempotency-key': key('ex') },
    );
    expect(exec.status, JSON.stringify(exec.body)).toBe(200);
    expect(
      (
        await rows<{ by: string | null }>(
          `SELECT "resolvedByUserId"::text AS by FROM anonymous_credit_note_refund WHERE id = $1`,
          [cash],
        )
      )[0]!.by,
    ).not.toBeNull();
  });

  // ═══════════════════════════ 2d. ONE accounting clock ═══════════════════════════
  it("SINGLE CLOCK: every timestamp the feature writes — note, lines, refund lines, outcome — is the application's accounting clock instant, never the database clock; the posting date derives from the same instant", async () => {
    const clock = w.h.app.get(SystemClock) as unknown as { now: () => Date };
    const real = clock.now;
    const t0 = real();
    const s = await sell();
    const note = await issue(s, [{ method: 'CASH', amountMinor: s.total }]);
    const noteId = str(note['id']);
    const refundId = str(refundOf(note, 'CASH')['id']);
    const iso = (v: unknown): string => new Date(str(v)).toISOString();
    const n = (
      await rows(`SELECT "issuedAt","createdAt" FROM anonymous_credit_note WHERE id = $1`, [noteId])
    )[0]!;
    const l = await rows(
      `SELECT "createdAt" FROM anonymous_credit_note_line WHERE "creditNoteId" = $1`,
      [noteId],
    );
    const r0 = (
      await rows(
        `SELECT "createdAt","updatedAt","resolvedAt" FROM anonymous_credit_note_refund WHERE id = $1`,
        [refundId],
      )
    )[0]!;
    // the application clock of this world is a FIXED instant: every issue-time timestamp equals it exactly (the database clock is months later)
    expect(iso(n['issuedAt'])).toBe(t0.toISOString());
    expect(iso(n['createdAt'])).toBe(t0.toISOString());
    expect(l.length).toBeGreaterThan(0);
    for (const row of l) expect(iso(row['createdAt'])).toBe(t0.toISOString());
    expect(iso(r0['createdAt'])).toBe(t0.toISOString());
    expect(iso(r0['updatedAt'])).toBe(t0.toISOString());
    expect(r0['resolvedAt']).toBeNull();
    // attest two days later on the application clock: resolvedAt / updatedAt are THAT instant, and the journal's posting date is its civil date
    const later = new Date(t0.getTime() + 2 * 86_400_000);
    clock.now = () => later;
    try {
      const ex = await w.req(
        'POST',
        execUrl(noteId, refundId),
        manager,
        {},
        { 'idempotency-key': key('ex') },
      );
      expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    } finally {
      clock.now = real;
    }
    const r1 = (
      await rows(
        `SELECT "resolvedAt","updatedAt","createdAt" FROM anonymous_credit_note_refund WHERE id = $1`,
        [refundId],
      )
    )[0]!;
    expect(iso(r1['resolvedAt'])).toBe(later.toISOString());
    expect(iso(r1['updatedAt'])).toBe(later.toISOString());
    expect(iso(r1['createdAt'])).toBe(t0.toISOString()); // creation is never rewritten
    const posted = str(
      (
        await rows(
          `SELECT to_char("postingDate",'YYYY-MM-DD') AS d FROM journal_entry WHERE "sourceKind" = 'anonymous_credit_note_refund' AND "sourceId" = $1`,
          [refundId],
        )
      )[0]!['d'],
    );
    const tz = str(
      (
        await rows(`SELECT "accountingTimezone" AS z FROM company WHERE id = $1`, [co.companyId])
      )[0]!['z'],
    );
    expect(posted).toBe(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(later)); // the civil date of THAT instant in the company's timezone
  });

  // ═══════════════════════════ 2e. F-9 worked example for the accountant (a MEASUREMENT, not a decision) ═══════════════════════════
  it("F-9 WORKED EXAMPLE: a manual card payment that was SETTLED through a batch and is then refunded leaves a STANDING credit on PAYMENT_CLEARING that no frozen flow clears (the settlement journal is emulated with the batch's own shape; nothing is decided or changed)", async () => {
    const s = await sell((t) => [{ method: 'CARD_TERMINAL', amountMinor: t }]);
    // 1. the sale itself: the walk-in sale journal debits PAYMENT_CLEARING for the manual card tender
    // 2. the frozen settlement finalisation (provider batches) credits PAYMENT_CLEARING by the gross and debits BANK — emulated here with that exact shape
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await rawJournal(c, 'SETTLEMENT_BATCH', randomUUID(), [
        { key: 'ASSET.BANK', dr: s.total, cr: 0n },
        { key: 'ASSET.PAYMENT_CLEARING', dr: 0n, cr: s.total },
      ]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
    // 3. the customer is refunded: a full credit note with a manual CARD refund, attested (a manual card posts nothing at attestation)
    const note = await issue(s, [{ method: 'CARD_TERMINAL', amountMinor: s.total }]);
    const refundId = str(refundOf(note, 'CARD_TERMINAL')['id']);
    const ex = await w.req(
      'POST',
      execUrl(str(note['id']), refundId),
      manager,
      {},
      { 'idempotency-key': key('ex') },
    );
    expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    expect(
      await rows(
        `SELECT 1 FROM journal_entry WHERE "sourceKind" = 'anonymous_credit_note_refund' AND "sourceId" = $1`,
        [refundId],
      ),
    ).toHaveLength(0);
    // the ledger effect of THIS sale's whole story, by account, from the journal tables
    const net = async (): Promise<Record<string, bigint>> => {
      const out: Record<string, bigint> = {};
      for (const r of await rows<{ k: string; n: string }>(
        `SELECT a.key AS k, sum(jl."debitMinor" - jl."creditMinor")::text AS n
           FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id JOIN account a ON a.id = jl."accountId"
          WHERE je."companyId" = $1 AND (je."sourceId" = $2 OR je."sourceId" = $3
                OR (je."sourceKind" = 'SETTLEMENT_BATCH' AND jl."debitMinor" + jl."creditMinor" = $4))
          GROUP BY a.key`,
        [co.companyId, s.invoiceId, str(note['id']), s.total.toString()],
      ))
        out[r.k] = BigInt(r.n);
      return out;
    };
    const l = await net();
    expect(l['ASSET.PAYMENT_CLEARING']).toBe(-s.total); // +total (sale) − total (settlement) − total (credit note issuance) = −total, STANDING
    expect(l['ASSET.BANK']).toBe(s.total); // the settled money is still in the bank
    expect(l['REVENUE.SALES'] ?? 0n).toBe(0n); // the sale is fully reversed
    expect(l['LIABILITY.TAX_PAYABLE'] ?? 0n).toBe(0n);
    expect(l['ASSET.CASH_ON_HAND'] ?? 0n).toBe(0n);
    // the clearing balance by source kind (control query Q8's shape): three contributors, one of them the standing credit
    const byKind = await rows<{ k: string; n: string }>(
      `SELECT je."sourceKind" AS k, sum(jl."debitMinor" - jl."creditMinor")::text AS n
         FROM journal_entry je JOIN journal_line jl ON jl."journalEntryId" = je.id JOIN account a ON a.id = jl."accountId"
        WHERE je."companyId" = $1 AND a.key = 'ASSET.PAYMENT_CLEARING' AND (je."sourceId" = $2 OR je."sourceId" = $3
              OR (je."sourceKind" = 'SETTLEMENT_BATCH' AND jl."creditMinor" = $4))
        GROUP BY je."sourceKind"`,
      [co.companyId, s.invoiceId, str(note['id']), s.total.toString()],
    );
    const m = Object.fromEntries(byKind.map((r) => [r.k, BigInt(r.n)]));
    expect(m['walk_in_sale']).toBe(s.total);
    expect(m['SETTLEMENT_BATCH']).toBe(-s.total);
    expect(m['anonymous_credit_note']).toBe(-s.total); // the in-flight credit that attestation of a manual card never converts
  });

  // ═══════════════════════════ 3. the mapping the database mirrors ═══════════════════════════
  it('PARITY: the database guard names exactly the frozen tender → account pairs the application uses (CASH → CASH_ON_HAND, BANK_TRANSFER → BANK; manual → no journal)', async () => {
    const def = str(
      (
        await rows(
          `SELECT pg_get_functiondef('fn_anon_cn_refund_execution_journal_guard'::regproc) AS d`,
        )
      )[0]!['d'],
    );
    const { resolveReceiptAccountKeyForTender } =
      await import('../payments/tender-account-mapping.js');
    expect(resolveReceiptAccountKeyForTender('CASH')).toBe('ASSET.CASH_ON_HAND');
    expect(resolveReceiptAccountKeyForTender('BANK_TRANSFER')).toBe('ASSET.BANK');
    expect(resolveReceiptAccountKeyForTender('CARD_TERMINAL')).toBe('ASSET.PAYMENT_CLEARING');
    expect(resolveReceiptAccountKeyForTender('OTHER_MANUAL')).toBe('ASSET.PAYMENT_CLEARING');
    expect(def).toContain(`WHEN 'CASH' THEN 'ASSET.CASH_ON_HAND'`);
    expect(def).toContain(`WHEN 'BANK_TRANSFER' THEN 'ASSET.BANK'`);
    expect(def).toMatch(/ELSE NULL END/);
  });

  // ═══════════════════════════ 4. the application keeps status + posting atomic ═══════════════════════════
  it('CONCURRENCY: eight simultaneous executions of one refund produce exactly one 200, seven 409s, one journal and one audit row', async () => {
    const s = await sell();
    const note = await issue(s, [{ method: 'CASH', amountMinor: s.total }]);
    const noteId = str(note['id']);
    const refundId = str(refundOf(note, 'CASH')['id']);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        w.req('POST', execUrl(noteId, refundId), manager, {}, { 'idempotency-key': key('ex') }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((x) => x === 200)).toHaveLength(1);
    expect(statuses.filter((x) => x === 409)).toHaveLength(7);
    expect(
      await rows(
        `SELECT 1 FROM journal_entry WHERE "sourceKind" = 'anonymous_credit_note_refund' AND "sourceId" = $1`,
        [refundId],
      ),
    ).toHaveLength(1);
    expect(
      await rows(
        `SELECT 1 FROM audit_log WHERE action = 'anonymous_credit_note.refund_executed' AND "resourceId" = $1`,
        [refundId],
      ),
    ).toHaveLength(1);
    expect(await statusOf(refundId)).toBe('EXECUTED');
  });

  // ═══════════════════════════ 5. the residual path is made visible ═══════════════════════════
  it('RESIDUAL: a superuser that disables triggers CAN set EXECUTED without a journal — the reconciliation control (Q3) reports exactly that amount', async () => {
    const q3 = async (): Promise<string> =>
      str(
        (
          await rows(
            `WITH expected AS (
               SELECT -(COALESCE((SELECT sum(n."totalAmountMinor") FROM anonymous_credit_note n WHERE n."companyId" = $1), 0)
                      - COALESCE((SELECT sum(r."amountMinor") FROM anonymous_credit_note_refund r
                                   WHERE r."companyId" = $1 AND r.status = 'EXECUTED' AND r.method IN ('CASH','BANK_TRANSFER')), 0)) AS v),
             actual AS (
               SELECT COALESCE(sum(jl."debitMinor" - jl."creditMinor"), 0) AS v FROM journal_entry je
                 JOIN journal_line jl ON jl."journalEntryId" = je.id JOIN account a ON a.id = jl."accountId"
                WHERE je."companyId" = $1 AND a.key = 'ASSET.PAYMENT_CLEARING'
                  AND je."sourceKind" IN ('anonymous_credit_note','anonymous_credit_note_refund'))
             SELECT ((SELECT v FROM expected) - (SELECT v FROM actual))::text AS d`,
            [co.companyId],
          )
        )[0]!['d'],
      );
    expect(await q3()).toBe('0'); // every legitimate flow above reconciles
    const s = await sell();
    const note = await issue(s, [{ method: 'CASH', amountMinor: s.total }]);
    const refundId = str(refundOf(note, 'CASH')['id']);
    expect(await q3()).toBe('0');
    expect(
      await asRole(null, null, (c) => markExecuted(c, refundId).then(() => undefined), {
        replica: true,
      }),
    ).toBe('OK');
    expect(await statusOf(refundId)).toBe('EXECUTED'); // the residual path: triggers disabled by a superuser
    expect(await q3()).toBe(s.total.toString()); // …and the control sees it
  });

  // ═══════════════════════════ 6. the application is atomic (must be LAST: it closes the accounting period) ═══════════════════════════
  it('ATOMICITY: a posting that fails (closed accounting period) rolls back the status, the journal and the audit row together — the refund stays PENDING and can still be attested later', async () => {
    const s = await sell();
    const note = await issue(s, [{ method: 'CASH', amountMinor: s.total }]);
    const noteId = str(note['id']);
    const refundId = str(refundOf(note, 'CASH')['id']);
    await admin.query(`UPDATE accounting_period SET status = 'CLOSED' WHERE "companyId" = $1`, [
      co.companyId,
    ]);
    const r = await w.req(
      'POST',
      execUrl(noteId, refundId),
      manager,
      {},
      { 'idempotency-key': key('ex') },
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(await statusOf(refundId)).toBe('PENDING');
    expect(
      await rows(
        `SELECT 1 FROM journal_entry WHERE "sourceKind" = 'anonymous_credit_note_refund' AND "sourceId" = $1`,
        [refundId],
      ),
    ).toHaveLength(0);
    expect(
      await rows(
        `SELECT 1 FROM audit_log WHERE action = 'anonymous_credit_note.refund_executed' AND "resourceId" = $1`,
        [refundId],
      ),
    ).toHaveLength(0);
    // reopen: the same refund is still executable, once, with its journal
    await admin.query(`UPDATE accounting_period SET status = 'OPEN' WHERE "companyId" = $1`, [
      co.companyId,
    ]);
    const again = await w.req(
      'POST',
      execUrl(noteId, refundId),
      manager,
      {},
      { 'idempotency-key': key('ex') },
    );
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await statusOf(refundId)).toBe('EXECUTED');
  });
});

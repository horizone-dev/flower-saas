import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (docs/phase-3/PHASE-3B-PLAN.md
// §J/§N/§13): the Posting Engine is an internal primitive that must
// PARTICIPATE in a caller's already-open transaction (never open its own),
// unlike every other scoped module's repositories which own their own
// `ScopedRepository.scoped(...)` boundary — so its public `postJournal(tx:
// ScopedTx, ...)` contract requires this type, and there is no
// `ScopedRepository`-style indirection that fits a callee that must NOT
// decide its own transaction boundary. Type-only import — no raw Prisma model
// access happens in this file outside `tx.<model>`/`tx.$queryRaw` calls on the
// caller-supplied, already-scoped `tx`.
// eslint-disable-next-line flower/no-raw-prisma-in-scoped-modules
import type { ScopedTx } from '@flower/db';
import { DomainError } from '../../common/errors/domain-error.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { SystemClock } from '../../common/clock/clock.js';
import { CompanyFinancialConfigRepository } from './company-financial-config.repository.js';
import { AccountingPeriodRepository } from './accounting-period.repository.js';
import { computePostingFingerprint, type PostingFingerprintLine } from './posting-fingerprint.js';
import { derivePostingDate } from './posting-date.js';
import { isPgError } from '../../common/errors/pg-error.js';

export interface PostJournalLine {
  accountKey: string;
  direction: 'debit' | 'credit';
  amountMinor: bigint;
}

export interface PostJournalInput {
  tenantId: string;
  companyId: string;
  sourceKind: string;
  sourceId: string;
  lines: PostJournalLine[];
  branchId?: string;
  posTerminalId?: string;
  description?: string;
  createdByUserId?: string | null;
}

export interface PostJournalResult {
  journalEntryId: string;
  created: boolean;
}

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Task 3b.1 — the internal Posting Engine primitive (docs/phase-3/
 * PHASE-3B-PLAN.md §J). NOT HTTP-exposed. No raw browser/POS-supplied
 * debit/credit posting API — this is called only by trusted internal domain
 * code (none exists yet; task 3b.1 ships the primitive without a producer).
 *
 * Participates in the CALLER's already-open `ScopedTx` — never opens or
 * commits its own transaction (CLAUDE.md rule 18: GL posting is synchronous,
 * inside the operational transaction). The posting instant is taken from the
 * injected `Clock`, never from `input` — a caller cannot supply/backdate a
 * posting instant.
 *
 * Idempotency: `(tenantId, companyId, sourceKind, sourceId)` is the DB-unique
 * posting identity. A conflicting insert is resolved via
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING id` (never by catching an
 * aborted-transaction unique-violation exception) — on conflict, the existing
 * row's `postingFingerprint` is compared to the freshly computed one: match →
 * idempotent no-op (no duplicate Journal/JournalLine/Audit); mismatch →
 * `JOURNAL_SOURCE_CONFLICT`.
 *
 * The DB's sealed-journal trigger set (task 3b.1 migration) is the ultimate
 * backstop proving balance/seal/min-lines at commit; this service still only
 * ever constructs genuinely balanced 2+-line input itself as defence in depth.
 */
@Injectable()
export class PostingEngineService {
  constructor(
    private readonly companyConfig: CompanyFinancialConfigRepository,
    private readonly periods: AccountingPeriodRepository,
    private readonly audit: AuditWriter,
    // injected as a class token (not the `Clock` interface, which is erased at
    // runtime) so a test can swap in a fake via Nest's `overrideProvider`.
    private readonly clock: SystemClock,
  ) {}

  async postJournal(tx: ScopedTx, input: PostJournalInput): Promise<PostJournalResult> {
    this.assertConstructedBalance(input.lines);

    const config = await this.companyConfig.lockForPosting(tx, input.companyId);
    const postingDate = derivePostingDate(this.clock.now(), config.accountingTimezone);
    const period = await this.periods.findOpenForPostingDate(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      postingDate,
    });

    const accountKeys = [...new Set(input.lines.map((l) => l.accountKey))];
    const accounts = await tx.account.findMany({
      where: { tenantId: input.tenantId, companyId: input.companyId, key: { in: accountKeys } },
      select: { id: true, key: true },
    });
    const accountIdByKey = new Map(accounts.map((a) => [a.key, a.id]));
    for (const key of accountKeys) {
      if (!accountIdByKey.has(key)) {
        throw new DomainError('ACCOUNT_KEY_UNKNOWN', `unknown account key "${key}"`, 422);
      }
    }

    const branchId = input.branchId ?? null;
    const posTerminalId = input.posTerminalId ?? null;
    const fingerprintLines: PostingFingerprintLine[] = input.lines.map((l) => ({
      accountKey: l.accountKey,
      direction: l.direction,
      amountMinor: l.amountMinor,
    }));
    const fingerprint = computePostingFingerprint({
      companyId: input.companyId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      currencyCode: config.defaultCurrency,
      lines: fingerprintLines,
      branchId,
      posTerminalId,
    });

    return this.insertAndSeal(tx, {
      ...input,
      branchId,
      posTerminalId,
      currencyCode: config.defaultCurrency,
      postingDate,
      accountingPeriodId: period.id,
      fingerprint,
      accountIdByKey,
      reversalOfJournalEntryId: null,
    });
  }

  /**
   * A full reversal is just another posting — same fingerprinting/idempotency/
   * sealing path — with `reversalOfJournalEntryId` set and every line's
   * direction inverted. The `UNIQUE(reversalOfJournalEntryId)` DB constraint
   * (task 3b.1 migration) already caps this at one full reversal per original.
   */
  async reverseJournal(
    tx: ScopedTx,
    input: {
      tenantId: string;
      companyId: string;
      originalJournalEntryId: string;
      sourceKind: string;
      sourceId: string;
      createdByUserId?: string | null;
    },
  ): Promise<PostJournalResult> {
    const original = await tx.journalEntry.findFirst({
      where: {
        id: input.originalJournalEntryId,
        tenantId: input.tenantId,
        companyId: input.companyId,
      },
      include: { lines: { include: { account: { select: { key: true } } } } },
    });
    if (!original) throw new DomainError('NOT_FOUND', 'journal entry not found', 404);

    const inverseLines: PostJournalLine[] = original.lines.map((line) => ({
      accountKey: line.account.key,
      direction: line.debitMinor > 0n ? 'credit' : 'debit',
      amountMinor: line.debitMinor > 0n ? line.debitMinor : line.creditMinor,
    }));

    this.assertConstructedBalance(inverseLines);
    const config = await this.companyConfig.lockForPosting(tx, input.companyId);
    const postingDate = derivePostingDate(this.clock.now(), config.accountingTimezone);
    const period = await this.periods.findOpenForPostingDate(tx, {
      tenantId: input.tenantId,
      companyId: input.companyId,
      postingDate,
    });

    const accountIdByKey = new Map(
      original.lines.map((l) => [l.account.key, l.accountId] as const),
    );
    const branchId: string | null = null;
    const posTerminalId: string | null = null;
    const fingerprint = computePostingFingerprint({
      companyId: input.companyId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      currencyCode: config.defaultCurrency,
      lines: inverseLines,
      branchId,
      posTerminalId,
    });

    try {
      return await this.insertAndSeal(tx, {
        tenantId: input.tenantId,
        companyId: input.companyId,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        lines: inverseLines,
        branchId,
        posTerminalId,
        ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
        currencyCode: config.defaultCurrency,
        postingDate,
        accountingPeriodId: period.id,
        fingerprint,
        accountIdByKey,
        reversalOfJournalEntryId: input.originalJournalEntryId,
        auditAction: 'accounting.journal_reversed',
      });
    } catch (err) {
      if (isPgError(err, PG_UNIQUE_VIOLATION)) {
        throw new DomainError(
          'JOURNAL_ALREADY_REVERSED',
          'this journal entry already has a full reversal',
          409,
        );
      }
      throw err;
    }
  }

  /** Defensive pre-check — the DB deferred trigger is the authoritative backstop. */
  private assertConstructedBalance(lines: PostJournalLine[]): void {
    if (lines.length < 2) {
      throw new DomainError('JOURNAL_UNBALANCED', 'a journal requires at least 2 lines', 500);
    }
    let debit = 0n;
    let credit = 0n;
    for (const l of lines) {
      if (l.direction === 'debit') debit += l.amountMinor;
      else credit += l.amountMinor;
    }
    if (debit !== credit || debit <= 0n) {
      throw new DomainError(
        'JOURNAL_UNBALANCED',
        'constructed posting lines are not balanced and positive',
        500,
      );
    }
  }

  private async insertAndSeal(
    tx: ScopedTx,
    args: {
      tenantId: string;
      companyId: string;
      sourceKind: string;
      sourceId: string;
      lines: PostJournalLine[];
      branchId: string | null;
      posTerminalId: string | null;
      description?: string;
      createdByUserId?: string | null;
      currencyCode: string;
      postingDate: string;
      accountingPeriodId: string;
      fingerprint: string;
      accountIdByKey: Map<string, string>;
      reversalOfJournalEntryId: string | null;
      auditAction?: 'accounting.journal_posted' | 'accounting.journal_reversed';
    },
  ): Promise<PostJournalResult> {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "journal_entry"
        ("tenantId","companyId","accountingPeriodId","postingDate","sourceKind","sourceId",
         "currencyCode","description","reversalOfJournalEntryId","postingFingerprint","createdByUserId")
      VALUES
        (${args.tenantId}::uuid, ${args.companyId}::uuid, ${args.accountingPeriodId}::uuid,
         ${args.postingDate}::date, ${args.sourceKind}, ${args.sourceId}, ${args.currencyCode},
         ${args.description ?? null}, ${args.reversalOfJournalEntryId}::uuid,
         ${args.fingerprint}, ${args.createdByUserId ?? null}::uuid)
      ON CONFLICT ("tenantId","companyId","sourceKind","sourceId") DO NOTHING
      RETURNING "id"`;

    const insertedRow = inserted[0];
    if (!insertedRow) {
      const existingRows = await tx.$queryRaw<{ id: string; postingFingerprint: string }[]>`
        SELECT "id", "postingFingerprint" FROM "journal_entry"
         WHERE "tenantId" = ${args.tenantId}::uuid AND "companyId" = ${args.companyId}::uuid
           AND "sourceKind" = ${args.sourceKind} AND "sourceId" = ${args.sourceId}`;
      const existing = existingRows[0];
      if (!existing) throw new DomainError('JOURNAL_NOT_SEALED', 'posting race unresolved', 500);
      if (existing.postingFingerprint !== args.fingerprint) {
        throw new DomainError(
          'JOURNAL_SOURCE_CONFLICT',
          'this source identity was already posted with different content',
          409,
        );
      }
      return { journalEntryId: existing.id, created: false };
    }

    const journalEntryId = insertedRow.id;
    await tx.journalLine.createMany({
      data: args.lines.map((l) => ({
        tenantId: args.tenantId,
        companyId: args.companyId,
        journalEntryId,
        accountId: accountIdFor(args.accountIdByKey, l.accountKey),
        branchId: args.branchId,
        posTerminalId: args.posTerminalId,
        debitMinor: l.direction === 'debit' ? l.amountMinor : 0n,
        creditMinor: l.direction === 'credit' ? l.amountMinor : 0n,
      })),
    });

    await tx.$executeRaw`UPDATE "journal_entry" SET "sealedAt" = now() WHERE "id" = ${journalEntryId}::uuid`;

    await this.audit.record(tx, {
      action: args.auditAction ?? 'accounting.journal_posted',
      resourceType: 'journal_entry',
      resourceId: journalEntryId,
      tenantId: args.tenantId,
      companyId: args.companyId,
      after: {
        sourceKind: args.sourceKind,
        sourceId: args.sourceId,
        journalEntryId,
        companyId: args.companyId,
        postingDate: args.postingDate,
      },
    });

    return { journalEntryId, created: true };
  }
}

function accountIdFor(map: Map<string, string>, key: string): string {
  const id = map.get(key);
  if (!id) throw new DomainError('ACCOUNT_KEY_UNKNOWN', `unknown account key "${key}"`, 422);
  return id;
}

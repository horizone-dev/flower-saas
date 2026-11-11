import { Module } from '@nestjs/common';
import { SystemClock } from '../../common/clock/clock.js';
import { AccessModule } from '../access/access.module.js';
import { AccountingModule } from '../accounting/accounting.module.js';
import { AnonymousCreditNoteController } from './anonymous-credit-note.controller.js';
import { AnonymousCreditNoteRepository } from './anonymous-credit-note.repository.js';
import { AnonymousCreditNoteService } from './anonymous-credit-note.service.js';
import { AnonymousCreditNoteSummaryController } from './anonymous-credit-note-summary.controller.js';
import { AnonymousCreditNoteSummaryRepository } from './anonymous-credit-note-summary.repository.js';

/**
 * Phase 3B closure — RB-1 A2: credit notes and refunds for an ANONYMOUS issued sale, and (F-1 / F-2) their read-only, ledger-reconciled
 * summary. Additive: it imports `AccountingModule` for the frozen posting engine and company configuration, re-declares nothing of any
 * frozen module, and is imported by `SettlementsModule` (not content-hash-pinned) because `app.module.ts` and the sales / order / payment /
 * receivables modules are byte-locked. `SystemClock` is provided here as the same class token the posting engine uses, so tests can
 * substitute a fake.
 */
@Module({
  imports: [AccountingModule, AccessModule],
  controllers: [AnonymousCreditNoteController, AnonymousCreditNoteSummaryController],
  providers: [
    AnonymousCreditNoteRepository,
    AnonymousCreditNoteService,
    AnonymousCreditNoteSummaryRepository,
    SystemClock,
  ],
})
export class AnonymousCreditNotesModule {}

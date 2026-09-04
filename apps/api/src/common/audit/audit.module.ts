import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditWriter } from './audit.writer.js';
import { OutboxWriter } from './outbox.writer.js';
import { ImpersonationReadInterceptor } from './impersonation-read.interceptor.js';

/**
 * Audit + outbox foundation (task 1.14). `AuditWriter` / `OutboxWriter` write
 * inside a caller's transaction (amendment 2 / CLAUDE.md §28). The
 * `ImpersonationReadInterceptor` records one `IMPERSONATION:read` row per
 * request served inside an impersonated session (OD7). No dispatcher / hash
 * chain in Phase 1 (ADR-0016).
 */
@Global()
@Module({
  providers: [
    AuditWriter,
    OutboxWriter,
    { provide: APP_INTERCEPTOR, useClass: ImpersonationReadInterceptor },
  ],
  exports: [AuditWriter, OutboxWriter],
})
export class AuditModule {}

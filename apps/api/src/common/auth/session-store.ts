import { Injectable } from '@nestjs/common';
import type { SessionData } from './session.types.js';

/**
 * Server-side session storage. The Redis implementation lands in task 1.5; the
 * interface + an in-memory implementation exist now so the guard pipeline is
 * fully testable.
 */
export abstract class SessionStore {
  abstract get(sessionId: string): Promise<SessionData | null>;
  abstract set(session: SessionData): Promise<void>;
  abstract revoke(sessionId: string, reason: string): Promise<void>;
  abstract delete(sessionId: string): Promise<void>;
}

/** DI token — the concrete store is bound in the pipeline module. */
export const SESSION_STORE = SessionStore;

@Injectable()
export class InMemorySessionStore extends SessionStore {
  private readonly map = new Map<string, SessionData>();

  get(sessionId: string): Promise<SessionData | null> {
    const s = this.map.get(sessionId) ?? null;
    if (s && s.expiresAt <= Date.now()) {
      this.map.delete(sessionId);
      return Promise.resolve(null);
    }
    return Promise.resolve(s ? structuredClone(s) : null);
  }

  set(session: SessionData): Promise<void> {
    this.map.set(session.sessionId, structuredClone(session));
    return Promise.resolve();
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    const s = this.map.get(sessionId);
    if (s) {
      s.revokedAt = Date.now();
      s.revokeReason = reason;
    }
  }

  delete(sessionId: string): Promise<void> {
    this.map.delete(sessionId);
    return Promise.resolve();
  }

  /** test helper */
  clear(): void {
    this.map.clear();
  }
}

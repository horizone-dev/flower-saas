import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { SessionAuthError, type SessionAuthenticator, type SessionData } from '@flower/backend';
import { extractToken } from './auth/token.js';
import type { GatewayHub, Connection } from './gateway/hub.js';

export interface RealtimeDeps {
  /** returns true when Redis (the outbox-stream source) is reachable */
  redisHealthy: () => Promise<boolean>;
  authenticator: SessionAuthenticator;
  hub: GatewayHub;
  onConnect?: (conn: Connection) => void;
  onClose?: (conn: Connection | null) => void;
  onAuthFailed?: (reason: string) => void;
}

const CLOSE_POLICY_VIOLATION = 4000;

/**
 * Builds the realtime gateway Fastify app (ARCHITECTURE §13-14, ADR-0017 §9,
 * task 2.5 — replaces the Phase-0 echo stub).
 *
 * On connect: extract the token (`auth/token.ts`), resolve the session via the
 * **shared** `SessionAuthenticator` (`@flower/backend` — the identical
 * primitive `apps/api`'s `AuthGuard` uses), register the socket with the
 * `GatewayHub` (tenant + branch topic authorization, live fanout, revocation).
 * A missing/invalid/wrong-realm/revoked/expired token closes the socket
 * immediately with a policy-violation code — **never** a client-suppliable
 * topic string, never a fallback to "connected but unauthorized".
 *
 * `refresh_token` re-runs the exact same authentication path with a new
 * token (ADR-0017 §9 — "re-run the guard pipeline on every … token refresh").
 * A narrower `branchScope` on the new session takes effect immediately: every
 * live delivery re-checks authorization against the connection's *current*
 * session, never a cached topic list.
 */
export async function buildRealtimeApp(deps: RealtimeDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  app.get('/healthz', () => ({ status: 'ok', role: 'realtime' }));

  app.get('/readyz', async (_req, reply) => {
    const ok = await deps.redisHealthy();
    void reply.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'down', role: 'realtime', checks: { redis: ok ? 'ok' : 'down' } };
  });

  app.get('/ws', { websocket: true }, (socket, request: FastifyRequest) => {
    let conn: Connection | null = null;

    void (async () => {
      const token = extractToken(request);
      if (!token) return closeUnauthorized(socket, deps, 'missing token');

      let session: SessionData;
      try {
        session = await deps.authenticator.authenticate(token, 'tenant');
      } catch (err) {
        return closeUnauthorized(
          socket,
          deps,
          err instanceof SessionAuthError ? err.message : 'authentication failed',
        );
      }

      conn = await deps.hub.register(session, socket);
      deps.onConnect?.(conn);
      socket.send(
        JSON.stringify({
          type: 'ack',
          protocol: 'flower-realtime/1',
          tenantId: session.tenantId,
          branchScope: session.access?.branchScope ?? [],
        }),
      );

      socket.on('message', (raw: Buffer) => {
        void handleMessage(raw, socket, deps, conn).then((updated) => {
          if (updated) conn = updated;
        });
      });

      socket.on('close', () => {
        if (conn) deps.hub.unregister(conn);
        deps.onClose?.(conn);
      });
    })();
  });

  return app;
}

async function handleMessage(
  raw: Buffer,
  socket: { send(data: string): void; close(code?: number, reason?: string): void },
  deps: RealtimeDeps,
  conn: Connection | null,
): Promise<Connection | null> {
  if (!conn) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return null; // malformed client message — ignore, never crash the socket over it
  }
  if (
    typeof msg !== 'object' ||
    msg === null ||
    (msg as { type?: unknown }).type !== 'refresh_token'
  ) {
    return null;
  }
  const token = (msg as { token?: unknown }).token;
  if (typeof token !== 'string' || token.length === 0) {
    socket.send(JSON.stringify({ type: 'error', code: 'MISSING_TOKEN', message: 'missing token' }));
    return null;
  }

  let session: SessionData;
  try {
    session = await deps.authenticator.authenticate(token, 'tenant');
  } catch (err) {
    const message = err instanceof SessionAuthError ? err.message : 'authentication failed';
    socket.send(JSON.stringify({ type: 'error', code: 'REAUTH_FAILED', message }));
    socket.close(CLOSE_POLICY_VIOLATION, 'reauthentication failed');
    return null;
  }

  await deps.hub.reauthorize(conn, session);
  socket.send(
    JSON.stringify({
      type: 'refreshed',
      tenantId: session.tenantId,
      branchScope: session.access?.branchScope ?? [],
    }),
  );
  return conn;
}

function closeUnauthorized(
  socket: { send(data: string): void; close(code?: number, reason?: string): void },
  deps: RealtimeDeps,
  reason: string,
): void {
  deps.onAuthFailed?.(reason);
  socket.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: reason }));
  socket.close(CLOSE_POLICY_VIOLATION, reason);
}

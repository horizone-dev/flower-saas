import { createConnection } from 'node:net';

/**
 * Minimal readiness probe: can we open a TCP connection to host:port within
 * `timeoutMs`? Later phases replace the DB / Redis / storage checks with real
 * protocol-level health (`SELECT 1`, `PING`, bucket HEAD).
 */
export function tcpProbe(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

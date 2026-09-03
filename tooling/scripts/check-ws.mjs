#!/usr/bin/env node
/**
 * WebSocket connect / ack / echo / close check for the realtime gateway
 * (Phase 0 verification — Tasks 0.7, 0.13). Exits non-zero on any failure.
 *
 * Uses Node's built-in `WebSocket` (Node >= 22) — no dependency.
 * Usage: node tooling/scripts/check-ws.mjs [ws://host:port/ws]
 */
const url = process.argv[2] ?? `ws://localhost:${process.env.REALTIME_PORT ?? 3002}/ws`;
const timeoutMs = 5000;

if (typeof WebSocket === 'undefined') {
  console.error('check-ws FAIL: this Node has no global WebSocket (need Node >= 22)');
  process.exit(1);
}

const fail = (msg) => {
  console.error(`check-ws FAIL: ${msg}`);
  process.exit(1);
};

const ws = new WebSocket(url);
const timer = setTimeout(() => fail(`no response within ${timeoutMs}ms (${url})`), timeoutMs);
let sawAck = false;

ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'ping' })));

ws.addEventListener('message', (event) => {
  let msg;
  try {
    msg = JSON.parse(String(event.data));
  } catch {
    return fail(`non-JSON message: ${String(event.data).slice(0, 120)}`);
  }
  if (msg.type === 'ack') {
    sawAck = true;
    return;
  }
  if (msg.type === 'echo') {
    if (!sawAck) return fail('received echo before ack');
    clearTimeout(timer);
    ws.close(1000, 'done');
  }
});

ws.addEventListener('close', (event) => {
  clearTimeout(timer);
  if (!sawAck) return fail('closed without an ack');
  console.log(`check-ws OK: connect -> ack -> echo -> close (code ${event.code}) @ ${url}`);
  process.exit(0);
});

ws.addEventListener('error', () => fail(`socket error connecting to ${url}`));

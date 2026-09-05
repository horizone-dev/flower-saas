/**
 * Realtime client (ARCHITECTURE §13-14, ADR-0009, ADR-0017 — task 2.6).
 *
 * `reducer.ts` — the pure, deterministic `EventReducer` (F8/F9-resolved: no
 * arithmetic `seq`-distance resync trigger anywhere; resource state advances
 * only on a genuinely newer `resourceVersion`; the scanned Stream cursor is
 * NOT tracked here at all — see `transport.ts`).
 *
 * `transport.ts` — the real WS transport: connect / auth / `resume` / apply
 * via the reducer / resync / reconnect with jittered backoff. The scanned
 * cursor lives here, persisted through an injectable `CursorStore`.
 */
export {
  EventReducer,
  reconnectDelayMs,
  type RealtimeEvent,
  type ApplyDecision,
} from './reducer.js';

export {
  RealtimeClient,
  inMemoryCursorStore,
  type RealtimeClientOptions,
  type CursorStore,
  type WebSocketLike,
  type WireEnvelope,
  type ConnectionState,
} from './transport.js';

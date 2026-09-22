import { describe, expect, it } from 'vitest';
import {
  assertPaymentAttemptTransition,
  canTransitionPaymentAttempt,
  PAYMENT_ATTEMPT_STATES,
  reservationStateForAttempt,
  type PaymentAttemptState,
} from './payment-attempt-state.js';

const TERMINAL: readonly PaymentAttemptState[] = ['CAPTURED', 'FAILED', 'CANCELED'];
const RESERVED: readonly PaymentAttemptState[] = ['PARTIALLY_REFUNDED', 'REFUNDED'];

describe('payment-attempt-state (task 3b.5 Checkpoint A — pure state machine)', () => {
  it('preserves the 8 accepted state values', () => {
    expect(PAYMENT_ATTEMPT_STATES).toEqual([
      'PENDING',
      'REQUIRES_ACTION',
      'AUTHORIZED',
      'CAPTURED',
      'FAILED',
      'CANCELED',
      'PARTIALLY_REFUNDED',
      'REFUNDED',
    ]);
  });

  describe('legal progression', () => {
    it('full provider chain PENDING -> REQUIRES_ACTION -> AUTHORIZED -> CAPTURED', () => {
      expect(canTransitionPaymentAttempt('PENDING', 'REQUIRES_ACTION')).toBe(true);
      expect(canTransitionPaymentAttempt('REQUIRES_ACTION', 'AUTHORIZED')).toBe(true);
      expect(canTransitionPaymentAttempt('AUTHORIZED', 'CAPTURED')).toBe(true);
    });

    it('local synchronous tender: PENDING -> CAPTURED directly', () => {
      expect(canTransitionPaymentAttempt('PENDING', 'CAPTURED')).toBe(true);
      expect(() => assertPaymentAttemptTransition('PENDING', 'CAPTURED')).not.toThrow();
    });

    it('shortcut edges: PENDING -> AUTHORIZED, REQUIRES_ACTION -> CAPTURED', () => {
      expect(canTransitionPaymentAttempt('PENDING', 'AUTHORIZED')).toBe(true);
      expect(canTransitionPaymentAttempt('REQUIRES_ACTION', 'CAPTURED')).toBe(true);
    });
  });

  describe('legal failure/cancel exits', () => {
    it('PENDING -> FAILED / CANCELED', () => {
      expect(canTransitionPaymentAttempt('PENDING', 'FAILED')).toBe(true);
      expect(canTransitionPaymentAttempt('PENDING', 'CANCELED')).toBe(true);
    });

    it('REQUIRES_ACTION -> FAILED / CANCELED', () => {
      expect(canTransitionPaymentAttempt('REQUIRES_ACTION', 'FAILED')).toBe(true);
      expect(canTransitionPaymentAttempt('REQUIRES_ACTION', 'CANCELED')).toBe(true);
    });
  });

  describe('AUTHORIZED has only one outgoing edge (accepted source defines no post-authorization failure/void edge)', () => {
    it('AUTHORIZED -> CAPTURED is the only legal edge out of AUTHORIZED', () => {
      expect(canTransitionPaymentAttempt('AUTHORIZED', 'CAPTURED')).toBe(true);
    });

    it('AUTHORIZED -> FAILED / CANCELED are NOT implemented in 3b.5 (deferred to the concrete provider adapter)', () => {
      expect(canTransitionPaymentAttempt('AUTHORIZED', 'FAILED')).toBe(false);
      expect(canTransitionPaymentAttempt('AUTHORIZED', 'CANCELED')).toBe(false);
      expect(() => assertPaymentAttemptTransition('AUTHORIZED', 'FAILED')).toThrow(RangeError);
      expect(() => assertPaymentAttemptTransition('AUTHORIZED', 'CANCELED')).toThrow(RangeError);
    });
  });

  describe('terminal states never regress', () => {
    for (const terminal of TERMINAL) {
      for (const target of PAYMENT_ATTEMPT_STATES) {
        it(`${terminal} -> ${target} is always illegal`, () => {
          expect(canTransitionPaymentAttempt(terminal, target)).toBe(false);
          expect(() => assertPaymentAttemptTransition(terminal, target)).toThrow(RangeError);
        });
      }
    }
  });

  it("no self-transition is a valid new transition (replay is the caller's concern, not this graph)", () => {
    for (const state of PAYMENT_ATTEMPT_STATES) {
      expect(canTransitionPaymentAttempt(state, state)).toBe(false);
    }
  });

  it('no 3b.5 transition enters PARTIALLY_REFUNDED / REFUNDED from anywhere', () => {
    for (const from of PAYMENT_ATTEMPT_STATES) {
      for (const target of RESERVED) {
        expect(canTransitionPaymentAttempt(from, target)).toBe(false);
      }
    }
  });

  it('no 3b.5 transition exits PARTIALLY_REFUNDED / REFUNDED', () => {
    for (const from of RESERVED) {
      for (const target of PAYMENT_ATTEMPT_STATES) {
        expect(canTransitionPaymentAttempt(from, target)).toBe(false);
      }
    }
  });

  it('assertPaymentAttemptTransition throws a plain RangeError on an illegal edge (pure-module convention)', () => {
    expect(() => assertPaymentAttemptTransition('CAPTURED', 'PENDING')).toThrow(RangeError);
  });

  describe('reservationStateForAttempt', () => {
    it('PENDING / REQUIRES_ACTION / AUTHORIZED are ACTIVE', () => {
      expect(reservationStateForAttempt('PENDING')).toBe('ACTIVE');
      expect(reservationStateForAttempt('REQUIRES_ACTION')).toBe('ACTIVE');
      expect(reservationStateForAttempt('AUTHORIZED')).toBe('ACTIVE');
    });

    it('CAPTURED is CONVERTED', () => {
      expect(reservationStateForAttempt('CAPTURED')).toBe('CONVERTED');
    });

    it('FAILED / CANCELED are RELEASED', () => {
      expect(reservationStateForAttempt('FAILED')).toBe('RELEASED');
      expect(reservationStateForAttempt('CANCELED')).toBe('RELEASED');
    });

    it('PARTIALLY_REFUNDED / REFUNDED fail closed (outside the 3b.5 reservation flow)', () => {
      expect(() => reservationStateForAttempt('PARTIALLY_REFUNDED')).toThrow(RangeError);
      expect(() => reservationStateForAttempt('REFUNDED')).toThrow(RangeError);
    });
  });
});

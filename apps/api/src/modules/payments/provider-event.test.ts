import { describe, expect, it } from 'vitest';
import { classifyProviderCaptureEvent } from './provider-event.js';

describe('provider-event (task 3b.5 Checkpoint A — pure late-event classification)', () => {
  it('CAPTURED claim while attempt is still an active reservation -> APPLY', () => {
    expect(classifyProviderCaptureEvent('PENDING')).toBe('APPLY');
    expect(classifyProviderCaptureEvent('REQUIRES_ACTION')).toBe('APPLY');
    expect(classifyProviderCaptureEvent('AUTHORIZED')).toBe('APPLY');
  });

  it('CAPTURED claim while attempt is already CAPTURED -> IDEMPOTENT_REPLAY (not an exception)', () => {
    expect(classifyProviderCaptureEvent('CAPTURED')).toBe('IDEMPOTENT_REPLAY');
  });

  it('CAPTURED claim after local terminal FAILED -> EXCEPTION', () => {
    expect(classifyProviderCaptureEvent('FAILED')).toBe('EXCEPTION');
  });

  it('CAPTURED claim after local terminal CANCELED -> EXCEPTION', () => {
    expect(classifyProviderCaptureEvent('CANCELED')).toBe('EXCEPTION');
  });

  it('CAPTURED claim against a reserved refund state -> EXCEPTION (never a silent apply)', () => {
    expect(classifyProviderCaptureEvent('PARTIALLY_REFUNDED')).toBe('EXCEPTION');
    expect(classifyProviderCaptureEvent('REFUNDED')).toBe('EXCEPTION');
  });
});

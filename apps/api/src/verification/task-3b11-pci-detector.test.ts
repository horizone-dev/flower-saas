import { describe, expect, it } from 'vitest';
import {
  CARD_KEY_RE,
  cardKeys,
  luhnValid,
  makeCanary,
  makePan,
  mask,
  scanText,
  scanValue,
} from './pci-canary.js';

/**
 * Task 3b.11 — P8: soundness of the PCI leak detector. A detector that cannot detect proves nothing, so this file proves
 * the detector finds every disguise of a planted canary, does not fire on ordinary system values, and that each
 * individual check is load-bearing (turning one off makes a planted leak go unnoticed). Synthetic data only.
 */
describe('PCI detector soundness (task 3b.11, P8)', () => {
  it('makePan produces Luhn-valid, correctly sized, non-network synthetic numbers; a corrupted number is not valid', () => {
    for (const len of [13, 15, 16, 19]) {
      const pan = makePan(len);
      expect(pan).toHaveLength(len);
      expect(pan.startsWith('999999')).toBe(true);
      expect(luhnValid(pan)).toBe(true);
      const last = pan.charCodeAt(pan.length - 1) - 48;
      expect(luhnValid(pan.slice(0, -1) + String((last + 1) % 10))).toBe(false);
    }
  });

  it('every disguise of the planted PAN is found by the exact-form check', () => {
    const c = makeCanary();
    for (const [name, form] of Object.entries(c.panForms)) {
      const hits = scanText(`{"x":"before ${form} after"}`, c);
      expect(
        hits.some((h) => h.kind === `form:${name}`),
        name,
      ).toBe(true);
    }
  });

  it('the marker catches the non-PAN canaries (CVV, expiry, track data) that no digit pattern could', () => {
    const c = makeCanary();
    for (const v of Object.values(c.tagged)) {
      expect(scanText(`stored: ${v}`, c).some((h) => h.kind === 'marker')).toBe(true);
    }
  });

  it('the generic Luhn check finds an UNKNOWN card number, grouped or not, with no canary supplied', () => {
    const pan = makePan(16);
    const groupedSpace = pan.replace(/(.{4})/g, '$1 ').trim();
    const groupedDash = pan.replace(/(.{4})/g, '$1-').slice(0, -1);
    for (const text of [pan, groupedSpace, groupedDash, `"cardholder note ${pan} end"`]) {
      expect(scanText(text).some((h) => h.kind === 'generic-luhn')).toBe(true);
    }
    expect(scanText(makePan(19)).some((h) => h.kind === 'generic-luhn')).toBe(true);
  });

  it('card-shaped property names are found at any depth, and ordinary lifetime fields are not', () => {
    expect(cardKeys({ a: { b: [{ cvv: '1' }] } })).toEqual(['cvv']);
    expect(cardKeys({ cardNumber: 'x', nested: { PAN: 'y', track2: 'z' } }).sort()).toEqual([
      'PAN',
      'cardNumber',
      'track2',
    ]);
    expect(
      cardKeys({ expiresAt: 1, expires: 2, createdAt: 3, panel: 4, pinned: 5, companyId: 6 }),
    ).toEqual([]);
    expect(CARD_KEY_RE.test('expiryDate')).toBe(true);
    expect(scanValue({ a: { cvv: '1' } }).some((h) => h.kind === 'card-key')).toBe(true);
  });

  it('ordinary system values do not trip the detector (UUIDs, amounts, timestamps, order numbers, ids)', () => {
    const benign = [
      '019a1b2c-3d4e-7f50-8a6b-0c1d2e3f4a5b',
      '00000000-0000-7000-8000-0000003b9a01',
      '{"amountMinor":"5303","currency":"AED","exponent":2,"invoiceNumber":"INV-000123","orderNumber":"ORD-000045"}',
      '{"createdAt":"2026-06-15T10:00:00.000Z","at":1781234567890,"version":12}',
      '{"keys":["a8f1c2d3e4b5","0123456789abcdef"],"hash":"sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"}',
      'x-sale-0001-abcdef',
    ];
    for (const b of benign) expect(scanText(b), b).toEqual([]);
  });

  it('a hit never exposes the raw canary: it is masked to the last four digits', () => {
    const c = makeCanary();
    const hits = scanText(`leak ${c.pan} and ${c.panForms['spaced']}`, c);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.masked).not.toContain(c.pan);
      expect(h.masked.replace(/\*/g, '')).toBe(c.pan.slice(-4));
    }
    expect(mask('1234567890123456')).toBe('************3456');
  });

  it('mutation checks: with the exact-form check, the marker check or the generic check disabled, a planted leak is missed', () => {
    const c = makeCanary();
    const planted = `{"note":"${c.tagged.pan}"}`;
    // full detector: found
    expect(scanText(planted, c).length).toBeGreaterThan(0);
    // exact-form check disabled (canary forms removed, marker kept): the marker still catches it
    const noForms = { ...c, panForms: {} };
    expect(scanText(planted, noForms).some((h) => h.kind === 'marker')).toBe(true);
    // marker check disabled (different marker): the exact form still catches it
    expect(
      scanText(planted, { ...c, marker: 'NOT-IN-TEXT' }).some((h) => h.kind.startsWith('form:')),
    ).toBe(true);
    // both disabled: only the generic Luhn check remains, and it still catches a plain PAN …
    const bare = { ...c, panForms: {}, marker: 'NOT-IN-TEXT' };
    expect(scanText(planted, bare).some((h) => h.kind === 'generic-luhn')).toBe(true);
    // … but a base64-wrapped PAN is invisible to it: the exact-form check is what covers that disguise
    const wrapped = `{"blob":"${c.panForms['base64Plain']}"}`;
    expect(scanText(wrapped, bare)).toEqual([]);
    expect(scanText(wrapped, c).some((h) => h.kind === 'form:base64Plain')).toBe(true);
  });
});

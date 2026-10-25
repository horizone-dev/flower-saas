import { describe, expect, it } from 'vitest';
import { makeCanary, scanText, type Canary } from '../../verification/pci-canary.js';
import { safePath } from './safe-path.js';

/**
 * F2 (task 3b.11) — the request path written to application logs carries no query string, no fragment and no card-shaped
 * digit run, while an ordinary application path is logged byte for byte. Synthetic canaries only (never printed).
 */

const NON_ASCII_DIGITS = new RegExp('[\\uff10-\\uff19\\u0660-\\u0669\\u06f0-\\u06f9\\u200b]');

/** what a reader of the log would see after decoding percent-escapes and folding look-alike digits / zero-width characters */
function readable(out: string): string {
  let text = out;
  try {
    text = decodeURIComponent(out);
  } catch {
    /* a malformed escape: read it as is */
  }
  return text.normalize('NFKC').replace(new RegExp('[\u200b-\u200d\u2060\ufeff]', 'g'), '');
}

function expectClean(label: string, out: string, c: Canary): void {
  for (const [view, text] of [
    ['as logged', out],
    ['decoded and folded', readable(out)],
  ] as const) {
    expect(
      scanText(text, c)
        .map((h) => h.kind)
        .filter((k) => k !== 'marker') /* the marker is only the test's label, never card data */,
      `${label} (${view}): leaked`,
    ).toEqual([]);
    expect(NON_ASCII_DIGITS.test(text), `${label} (${view}): look-alike digits echoed`).toBe(false);
    // the marker is only the test's label (its 12 random hex chars may contain digits) — judge the rest
    expect(
      /\d{8,}/.test(text.split(c.marker).join('')),
      `${label} (${view}): a long digit run survived`,
    ).toBe(false);
  }
}

describe('F2 safePath — ordinary paths are logged unchanged', () => {
  const company = '0191f3a0-7b1c-7d2e-8f3a-4b5c6d7e8f90';
  const branch = '0191f3a0-7b1c-7d2e-8f3a-4b5c6d7e8f91';
  it('route trees, UUIDs, slugs, short numbers and dates are byte-identical', () => {
    for (const p of [
      '/',
      '',
      '/v1/healthz',
      `/v1/companies/${company}/branches/${branch}/orders`,
      `/v1/companies/${company}/reports/trial-balance`,
      '/v1/catalog/products/rose-bouquet-12',
      '/v1/catalog/uoms/piece',
      '/v1/orders/ORD-000123',
      '/v1/x/2026-06-15/2026-06-30',
      '/v1/things/12345678901', // 11 digits: below the card-length floor
      '/v1/a//b/', // empty segments keep their slashes
      '/v1/caf%C3%A9/menu', // a valid escape with no digits is left exactly as received
      '/v1/bad%ZZescape',
    ]) {
      expect(safePath(p), p).toBe(p);
    }
  });

  it('missing input gives an empty path', () => {
    expect(safePath(undefined)).toBe('');
    expect(safePath('')).toBe('');
  });

  it('the query string and the fragment are removed, wherever they start', () => {
    expect(safePath('/v1/a/b?x=1&y=2')).toBe('/v1/a/b');
    expect(safePath('/v1/a/b#frag')).toBe('/v1/a/b');
    expect(safePath('/v1/a/b?x=1#frag')).toBe('/v1/a/b');
    expect(safePath('/v1/a/b#frag?x=1')).toBe('/v1/a/b');
    expect(safePath('/v1/a/b?')).toBe('/v1/a/b');
    expect(safePath('?only=query')).toBe('');
  });
});

describe('F2 safePath — card-shaped query strings and path segments never survive', () => {
  it('a card number in the query string (any form) is gone with the rest of the query', () => {
    const c = makeCanary();
    for (const [name, form] of Object.entries(c.panForms)) {
      const out = safePath(`/v1/catalog/products?q=${form}&cardNumber=${c.pan}#${form}`);
      expect(out, name).toBe('/v1/catalog/products');
    }
  });

  it('a card number as a path segment, in every disguise, is masked', () => {
    const c = makeCanary();
    const fullWidth = [...c.pan].map((d) => String.fromCharCode(0xff10 + Number(d))).join('');
    const arabicIndic = [...c.pan].map((d) => String.fromCharCode(0x0660 + Number(d))).join('');
    const forms: Record<string, string> = {
      plain: c.pan,
      spaced: encodeURIComponent(c.panForms['spaced']!),
      spacedRaw: c.panForms['spaced']!,
      dashed: c.panForms['dashed']!,
      dotted: c.panForms['dotted']!,
      underscored: c.pan.replace(/(.{4})/g, '$1_').replace(/_$/, ''),
      fullWidth: encodeURIComponent(fullWidth),
      arabicIndic: encodeURIComponent(arabicIndic),
      zeroWidthSplit: encodeURIComponent([...c.pan].join('​')),
      percentDigits: [...c.pan].map((d) => `%3${d}`).join(''),
      prefixedWord: `card${c.pan}`,
      suffixedWord: `${c.pan}x`,
      tagged: encodeURIComponent(c.tagged.pan),
      track2: encodeURIComponent(c.track2),
    };
    for (const [name, seg] of Object.entries(forms)) {
      for (const path of [
        `/${seg}`,
        `/v1/${seg}`,
        `/v1/companies/${seg}/branches/x/orders`,
        `/v1/catalog/products/${seg}/variants`,
      ]) {
        expectClean(`${name} in ${path.split(seg).join('<seg>')}`, safePath(path), c);
      }
    }
    // the surrounding route text is still there, so the line stays useful
    expect(safePath(`/v1/companies/${c.pan}/branches/x/orders`)).toBe(
      '/v1/companies/[digits]/branches/x/orders',
    );
  });

  it('a UUID-shaped segment that hides a card number is masked; an ordinary UUID is not', () => {
    const c = makeCanary();
    const p = c.pan;
    const sneaky = `${p.slice(0, 8)}-${p.slice(8, 12)}-${p.slice(12, 16)}-0000-000000000000`;
    expect(safePath(`/v1/x/${sneaky}`)).toBe('/v1/x/[masked]');
    const ok = '0191f3a0-7b1c-7d2e-8f3a-4b5c6d7e8f90';
    expect(safePath(`/v1/x/${ok}`)).toBe(`/v1/x/${ok}`);
  });

  it('a card number is masked wherever it appears among several segments, and other segments are untouched', () => {
    const c = makeCanary();
    const out = safePath(`/v1/a/${c.pan}/b/${c.panForms['dashed']}/c?x=${c.pan}`);
    expect(out).toBe('/v1/a/[digits]/b/[digits]/c');
  });
});

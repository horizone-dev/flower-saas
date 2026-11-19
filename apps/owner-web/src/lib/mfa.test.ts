import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { groupSecret, parseTotpCode, qrMatrix, qrSvg } from './mfa';

const URI =
  'otpauth://totp/Flower%20SaaS:01a1db4f-71a5-708b-a63d-5fe6fc7261c7?secret=IRTRSYATDEZV2QCUJBSWY3DPEHPK3PXP&issuer=Flower%20SaaS';

/** rasterise the matrix exactly as a phone would see it (4-module quiet zone) and decode it with an INDEPENDENT decoder */
function decode(m: boolean[][]): string | null {
  const scale = 8;
  const quiet = 4;
  const size = (m.length + quiet * 2) * scale;
  const px = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m.length; c++) {
      if (!m[r]![c]) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }
  }
  return jsQR(px, size, size)?.data ?? null;
}

describe('QR code for the authenticator URI', () => {
  it('decodes back to EXACTLY the otpauth URI (an independent decoder reads it)', () => {
    expect(decode(qrMatrix(URI))).toBe(URI);
  });

  it('works for short and long labels, all with the same decoder', () => {
    for (const uri of [
      'otpauth://totp/Flower%20SaaS:a?secret=JBSWY3DPEHPK3PXP&issuer=Flower%20SaaS',
      `otpauth://totp/Flower%20SaaS:${'x'.repeat(60)}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Flower%20SaaS`,
    ]) {
      expect(decode(qrMatrix(uri))).toBe(uri);
    }
  });

  it('refuses anything that is not an otpauth TOTP URI (never renders arbitrary text as a QR)', () => {
    for (const bad of ['', 'https://evil.example', 'otpauth://hotp/x?secret=A', '<script>']) {
      expect(() => qrMatrix(bad)).toThrow(/otpauth/);
    }
  });

  it('the SVG is only an <svg> with one <path>: no script, no external reference, no secret text', () => {
    const svg = qrSvg(URI);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
    expect((svg.match(/<[a-z]+/g) ?? []).sort()).toEqual(['<path', '<svg']);
    expect(svg).not.toMatch(/script|href|on[a-z]+=|IRTRSYAT/i);
  });

  it('what the user SEES decodes too: the SVG path rebuilt into a matrix equals the verified matrix (and decodes to the URI)', () => {
    const svg = qrSvg(URI);
    const size = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1]);
    const n = size - 8; // 4-module quiet zone each side
    const m: boolean[][] = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
    for (const run of svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      const [x, y, w] = [Number(run[1]), Number(run[2]), Number(run[3])];
      for (let i = 0; i < w; i++) m[y! - 4]![x! - 4 + i] = true;
    }
    expect(m).toEqual(qrMatrix(URI));
    expect(decode(m)).toBe(URI);
  });
});

describe('secret display and code entry', () => {
  it('groups the secret in fours for manual entry', () => {
    expect(groupSecret('irtrsyatdezv2qcu')).toBe('IRTR SYAT DEZV 2QCU');
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
  });

  it('accepts a 6-digit code with spaces; refuses anything else', () => {
    expect(parseTotpCode('123456')).toBe('123456');
    expect(parseTotpCode(' 123 456 ')).toBe('123456');
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5a', null, undefined]) {
      expect(parseTotpCode(bad as string | null | undefined)).toBeNull();
    }
  });
});

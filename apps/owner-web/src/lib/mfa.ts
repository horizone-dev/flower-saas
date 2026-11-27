import qrcode from 'qrcode-generator';

/**
 * Pure helpers for the Owner Web authenticator (TOTP) enrolment screen. NO authentication rule lives here: the API creates the pending factor,
 * decides whether a code is right and whether MFA is required. These only draw the QR code, format the secret for manual entry, and normalise
 * what the user types. Nothing here stores or logs anything, and the secret never leaves the caller's variables.
 */

/** the QR code as a module matrix (true = dark). ONLY an `otpauth://totp/…` URI is ever encoded — never arbitrary text */
export function qrMatrix(uri: string): boolean[][] {
  if (!/^otpauth:\/\/totp\/[^\s]+$/.test(uri)) {
    throw new Error('refusing to draw a QR code that is not an otpauth TOTP URI');
  }
  const qr = qrcode(0, 'M'); // automatic version, medium error correction
  qr.addData(uri, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/**
 * The QR code as an inline SVG: one `<svg>` and one `<path>`, built only from numbers we computed (a 4-module quiet zone is part of the
 * viewBox). No script, no external reference, no text from the URI — so it is safe to render with `dangerouslySetInnerHTML`.
 */
export function qrSvg(uri: string): string {
  const m = qrMatrix(uri);
  const quiet = 4;
  const size = m.length + quiet * 2;
  let d = '';
  for (let r = 0; r < m.length; r++) {
    let c = 0;
    while (c < m.length) {
      if (!m[r]![c]) {
        c++;
        continue;
      }
      let run = 0;
      while (c + run < m.length && m[r]![c + run]) run++;
      d += `M${c + quiet} ${r + quiet}h${run}v1h-${run}z`;
      c += run;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code for your authenticator app"><path fill="#000" d="${d}"/></svg>`;
}

/** `IRTRSYATDEZV2QCU` → `IRTR SYAT DEZV 2QCU` (for typing it into an authenticator by hand) */
export function groupSecret(secret: string): string {
  return (secret.toUpperCase().match(/.{1,4}/g) ?? []).join(' ');
}

/** a 6-digit code, with spaces tolerated; anything else is null (the API still decides whether it is correct) */
export function parseTotpCode(raw: string | null | undefined): string | null {
  const s = (raw ?? '').replace(/\s+/g, '');
  return /^\d{6}$/.test(s) ? s : null;
}

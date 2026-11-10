import { randomInt, randomUUID } from 'node:crypto';

/** Test-only helpers: SYNTHETIC secrets, generated at run time, never real and never printed. Excluded from the build. */

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** a Luhn-valid synthetic 16-digit number from a non-issuable prefix */
export function makePan(): string {
  let body = '999999';
  while (body.length < 15) body += String(randomInt(0, 10));
  for (let d = 0; d <= 9; d++) if (luhnValid(body + String(d))) return body + String(d);
  throw new Error('unreachable');
}

export interface Secrets {
  readonly pan: string;
  readonly token: string;
  readonly password: string;
  readonly person: string;
  readonly email: string;
  /** every string that must never appear in any emitted log text */
  readonly all: readonly string[];
}

export function makeSecrets(): Secrets {
  const pan = makePan();
  const token = `sk_live_${randomUUID().replace(/-/g, '')}`;
  const password = `Hunter2-${randomUUID().slice(0, 8)}!`;
  const person = `Zorblax Quimby ${randomUUID().slice(0, 6)}`;
  const email = `canary.${randomUUID().slice(0, 8)}@example.test`;
  const spaced = (pan.match(/.{1,4}/g) ?? []).join(' ');
  return {
    pan,
    token,
    password,
    person,
    email,
    all: [
      pan,
      spaced,
      spaced.replace(/ /g, '-'),
      Buffer.from(pan).toString('base64'),
      token,
      password,
      person,
      email,
    ],
  };
}

/** the secrets that appear in `text` (as logged, and as a reader would see it after decoding/folding digits) */
export function leaked(text: string, secrets: Secrets): string[] {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    /* read as is */
  }
  const folded = decoded
    .normalize('NFKC')
    .replace(new RegExp('[\\u200b-\\u200d\\u2060\\ufeff]', 'g'), '');
  return secrets.all
    .filter((s) => text.includes(s) || folded.includes(s))
    .map((s) => `${s.slice(0, 4)}…(${s.length})`);
}

export interface PrismaLikeOptions {
  readonly code?: string;
  readonly operation?: string;
  readonly value: string;
  readonly sqlstate?: string;
}

/** an error shaped exactly like a Prisma 7 validation error (name, code, clientVersion, meta, multi-line message + excerpt) */
export function prismaLikeError(o: PrismaLikeOptions): Error {
  const op = o.operation ?? 'tx.user.findUnique()';
  const reason = `Inconsistent column data: Invalid input value: invalid input syntax for type uuid: "${o.value}"`;
  const message = [
    '',
    `Invalid \`${op}\` invocation in`,
    'C:/Users/EXPERT/Desktop/Flower SaaS/apps/api/src/modules/access/access.repository.ts:81:34',
    '',
    `  78 // ── reads ──`,
    `  79 async loadUser(id: string) {`,
    `  80   return tx.user.findUnique({`,
    `→ 81     where: { id: "${o.value}" },`,
    '',
    reason,
  ].join('\n');
  const err = Object.assign(new Error(message), {
    code: o.code ?? 'P2007',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'User',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: o.sqlstate ?? '22P02',
          originalMessage: `invalid input syntax for type uuid: "${o.value}"`,
          kind: 'postgres',
        },
      },
    },
  });
  err.name = 'PrismaClientKnownRequestError';
  err.stack = `PrismaClientKnownRequestError: ${message}\n    at PrismaClientFetcher.request (C:/Users/EXPERT/Desktop/Flower SaaS/node_modules/.pnpm/@prisma+client@7.10.0/node_modules/@prisma/client/runtime/client.js:12:34)\n    at AccessRepository.loadUser (C:/Users/EXPERT/Desktop/Flower SaaS/apps/api/src/modules/access/access.repository.ts:81:34)\n    at async PolicyService.preview (C:/Users/EXPERT/Desktop/Flower SaaS/apps/api/src/modules/access/policy.service.ts:58:28)`;
  return err;
}

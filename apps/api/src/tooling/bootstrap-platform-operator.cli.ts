/**
 * Interactive CLI: create the FIRST platform operator.
 *
 *   docker compose run --rm -it bootstrap-operator        (staging compose; the API image, dist/tooling/…)
 *   node dist/tooling/bootstrap-platform-operator.cli.js --email ops@example.com --name "Ops Lead"
 *
 * Needs PLATFORM_DATABASE_URL (the flower_platform login role). REFUSES to run without a TTY: the password is typed (hidden) by the operator
 * and the authenticator code is entered live, so there is nothing to put in an env var, a file, a CI log or a shell history, and no
 * automation can run it unattended. Prints the TOTP secret once to the terminal; stores no credential anywhere but the database.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { createPrismaClient } from '@flower/db';
import { PasswordService } from '../common/crypto/password.service.js';
import { TotpService } from '../common/crypto/totp.service.js';
import {
  BootstrapInputError,
  OperatorBootstrapRefused,
  bootstrapPlatformOperator,
} from './platform-operator-bootstrap.js';
import { PlatformOperatorBootstrapRepository } from './platform-operator-bootstrap.repository.js';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg: string, code = 2): never => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};

function ask(question: string, hidden: boolean): Promise<string> {
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    muted = hidden;
  });
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('refused: this command is interactive (needs a terminal); it cannot run unattended');
  }
  const url = process.env['PLATFORM_DATABASE_URL'];
  if (!url) fail('refused: PLATFORM_DATABASE_URL is required');
  const email = flag('email');
  const name = flag('name');
  if (!email || !name) fail('usage: --email <address> --name "<full name>" [--allow-additional]');

  const password = await ask('Choose a password (14+ characters, hidden): ', true);
  const again = await ask('Repeat the password: ', true);
  if (password !== again) fail('refused: the passwords do not match');

  const totp = new TotpService();
  const secret = totp.generateSecret();
  process.stdout.write(
    `\nAdd this account to your authenticator app NOW (shown once, never stored by this tool):\n  secret : ${secret}\n  uri    : ${totp.keyUri(email!, secret)}\n\n`,
  );
  const code = await ask('Enter the CURRENT 6-digit code from the app: ', false);

  const prisma = createPrismaClient({ connectionString: url! });
  try {
    const passwords = new PasswordService();
    const { operatorId } = await bootstrapPlatformOperator(
      {
        hashPassword: (p) => passwords.hash(p),
        verifyTotp: (c, s) => totp.verify(c, s),
        repo: new PlatformOperatorBootstrapRepository(prisma),
      },
      {
        email: email!,
        name: name!,
        password,
        totpSecret: secret,
        totpCode: code,
        allowAdditional: args.includes('--allow-additional'),
      },
    );
    process.stdout.write(
      `\nPlatform operator created (${operatorId}). Sign in with the password AND the 6-digit code.\n`,
    );
  } catch (e) {
    if (e instanceof BootstrapInputError || e instanceof OperatorBootstrapRefused)
      fail(`refused: ${e.message}`);
    throw e;
  } finally {
    await prisma.$disconnect();
  }
}

await main();

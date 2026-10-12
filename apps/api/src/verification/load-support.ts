import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { freemem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type pg from 'pg';

/**
 * Task 3b.10 Checkpoint G — shared support of the LOCAL load-verification suites (HTTP only; nothing here imports a
 * reporting class). Everything it creates is disposable: PostgreSQL 17 containers named `flower-saas-load-*` with a
 * 512 MB `/dev/shm`, removed by name only. All figures are local test-container observations:
 * "Local test-container benchmark; not production capacity."
 */
export const DISCLAIMER = 'Local test-container benchmark; not production capacity.';
export const MB = 1024 * 1024;
/** the heavy suites (25 000-document world, 60 s mixed phases) are OPT-IN */
export const HEAVY = process.env['G_LOAD'] === '1';
export const SHM_MB = Number(process.env['G_SHM_MB'] ?? 512);
/** safety limits (owner-approved stop conditions) */
export const MIN_HOST_FREE_MB = 1024;
export const MAX_CONTAINER_MB = 3072;
export const METRICS_DIR = process.env['G_METRICS_DIR'] ?? join(tmpdir(), 'flower-saas-g-metrics');

const sh = promisify(execFile);

export function writeMetrics(name: string, data: unknown): string {
  mkdirSync(METRICS_DIR, { recursive: true });
  const file = join(METRICS_DIR, name);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// ── statistics ──────────────────────────────────────────────────────────────────────────────
export const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!);
};
export const max = (xs: number[]): number => (xs.length ? Math.round(Math.max(...xs)) : Number.NaN);
const VOLATILE = /^(asOf|generatedAt|readAt|snapshotAt)$/;
/** canonical JSON of a report body, server-derived timestamps excluded */
export const digest = (v: unknown): string =>
  createHash('sha256')
    .update(
      JSON.stringify(v, (k, x) =>
        VOLATILE.test(k)
          ? undefined
          : x && typeof x === 'object' && !Array.isArray(x)
            ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort())
            : x,
      ),
    )
    .digest('hex');

export interface Timed<T> {
  ms: number;
  value: T;
}
export async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

// ── the disposable PostgreSQL container (512 MB shm) ─────────────────────────────────────────
export interface LoadPostgres {
  readonly name: string;
  readonly url: string;
  readonly shmMb: number;
  stop(): Promise<void>;
}

const docker = (args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000 }).trim();

export async function startLoadPostgres(label: string, shmMb = SHM_MB): Promise<LoadPostgres> {
  const name = `flower-saas-load-${label}-${randomUUID().slice(0, 8)}`;
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'flower-saas-load=1',
    `--shm-size=${shmMb}m`,
    '-e',
    'POSTGRES_DB=flower_test',
    '-e',
    'POSTGRES_USER=flower',
    '-e',
    'POSTGRES_PASSWORD=flower_test',
    '-p',
    '127.0.0.1::5432',
    'postgres:17',
  ]);
  const ready = async (): Promise<boolean> => {
    try {
      await sh('docker', [
        'exec',
        name,
        'psql',
        '-U',
        'flower',
        '-d',
        'flower_test',
        '-Atc',
        'select 1',
      ]);
      return true;
    } catch {
      return false;
    }
  };
  let ok = 0;
  for (let i = 0; i < 90 && ok < 2; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    ok = (await ready()) ? ok + 1 : 0; // the image restarts once after init: require two good probes in a row
  }
  if (ok < 2) {
    docker(['rm', '-f', name]);
    throw new Error(`disposable PostgreSQL ${name} did not become ready`);
  }
  const port = docker(['port', name, '5432/tcp']).split('\n')[0]!.split(':').pop()!;
  return {
    name,
    shmMb,
    url: `postgres://flower:flower_test@127.0.0.1:${port}/flower_test`,
    stop: async () => {
      try {
        docker(['rm', '-f', name]);
      } catch {
        /* already gone */
      }
    },
  };
}

export async function postgresSettings(
  admin: pg.Pool,
  container: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const s of [
    'server_version',
    'max_parallel_workers_per_gather',
    'max_parallel_workers',
    'max_worker_processes',
    'dynamic_shared_memory_type',
    'work_mem',
    'shared_buffers',
    'jit',
    'max_connections',
  ]) {
    out[s] = ((await admin.query(`SHOW ${s}`)).rows[0] as Record<string, string>)[s];
  }
  try {
    const df = (
      await sh('docker', [
        'exec',
        container,
        'sh',
        '-c',
        "df -k /dev/shm | tail -1 | awk '{print $2}'",
      ])
    ).stdout;
    out['devShmMb'] = Math.round(Number(String(df).trim()) / 1024);
  } catch {
    out['devShmMb'] = null;
  }
  return out;
}

export async function shmUsedKb(container: string): Promise<number> {
  try {
    const r = await sh('docker', [
      'exec',
      container,
      'sh',
      '-c',
      "df -k /dev/shm | tail -1 | awk '{print $3}'",
    ]);
    return Number(String(r.stdout).trim());
  } catch {
    return Number.NaN;
  }
}

export async function containerMemMb(container: string): Promise<number> {
  try {
    const r = await sh('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', container]);
    const used = String(r.stdout).split('/')[0]!.trim();
    const m = /^([\d.]+)\s*(KiB|MiB|GiB|B)$/.exec(used);
    if (!m) return Number.NaN;
    const n = Number(m[1]);
    return m[2] === 'GiB' ? n * 1024 : m[2] === 'MiB' ? n : m[2] === 'KiB' ? n / 1024 : n / MB;
  } catch {
    return Number.NaN;
  }
}

/** PostgreSQL `53100` (shared-memory exhaustion) lines in the container's log */
export async function pgShmErrors(container: string): Promise<number> {
  try {
    const r = await sh('docker', ['logs', container], { maxBuffer: 512 * MB });
    const text = String(r.stdout) + String(r.stderr);
    return text.split('could not resize shared memory segment').length - 1;
  } catch {
    return 0;
  }
}

export async function deadlocks(admin: pg.Pool): Promise<number> {
  const r = await admin.query(
    `SELECT deadlocks::int AS d FROM pg_stat_database WHERE datname = current_database()`,
  );
  return (r.rows[0] as { d: number }).d;
}

// ── the resource monitor (pool · shared memory · container + host memory · lightweight probe) ─
export interface MonitorSummary {
  poolPeakTotal: number;
  poolPeakActive: number;
  shmPeakMb: number;
  containerMemPeakMb: number;
  hostFreeMinMb: number;
  light: { n: number; p50: number; p95: number; max: number; failures: number };
  tripped: string | null;
}

export class Monitor {
  private running = false;
  private loops: Promise<void>[] = [];
  private poolTotal = 0;
  private poolActive = 0;
  private shmKb = 0;
  private memMb = 0;
  private hostMin = Number.POSITIVE_INFINITY;
  private lightMs: number[] = [];
  private lightFail = 0;
  tripped: string | null = null;

  constructor(
    private readonly o: {
      admin: pg.Pool;
      container: string;
      ping: () => Promise<unknown>;
      /** enforce the owner-approved stop conditions (host / container memory); the normal CI-sized run only records them */
      enforce?: boolean;
    },
  ) {}

  start(): void {
    this.running = true;
    this.poolTotal = this.poolActive = this.shmKb = this.memMb = 0;
    this.hostMin = Number.POSITIVE_INFINITY;
    this.lightMs = [];
    this.lightFail = 0;
    const loop = (fn: () => Promise<void>, gapMs: number) =>
      (async () => {
        while (this.running) {
          await fn();
          await new Promise((r) => setTimeout(r, gapMs));
        }
      })();
    this.loops = [
      loop(async () => {
        const r = await this.o.admin.query(
          `SELECT count(*)::int total, count(*) FILTER (WHERE state='active')::int active
             FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
        );
        const row = r.rows[0] as { total: number; active: number };
        this.poolTotal = Math.max(this.poolTotal, row.total);
        this.poolActive = Math.max(this.poolActive, row.active);
      }, 150),
      loop(async () => {
        const kb = await shmUsedKb(this.o.container);
        if (Number.isFinite(kb)) this.shmKb = Math.max(this.shmKb, kb);
      }, 0),
      loop(async () => {
        const mem = await containerMemMb(this.o.container);
        if (Number.isFinite(mem)) this.memMb = Math.max(this.memMb, mem);
        const free = freemem() / MB;
        this.hostMin = Math.min(this.hostMin, free);
        if (this.o.enforce !== false && free < MIN_HOST_FREE_MB)
          this.tripped = `host free memory ${Math.round(free)} MB < ${MIN_HOST_FREE_MB} MB`;
        if (this.o.enforce !== false && mem > MAX_CONTAINER_MB)
          this.tripped = `container memory ${Math.round(mem)} MB > ${MAX_CONTAINER_MB} MB`;
      }, 500),
      loop(async () => {
        const t0 = performance.now();
        try {
          await this.o.ping();
          this.lightMs.push(performance.now() - t0);
        } catch {
          this.lightFail++;
        }
      }, 40),
    ];
  }

  async stop(): Promise<MonitorSummary> {
    this.running = false;
    await Promise.all(this.loops);
    return {
      poolPeakTotal: this.poolTotal,
      poolPeakActive: this.poolActive,
      shmPeakMb: Math.round(this.shmKb / 1024),
      containerMemPeakMb: Math.round(this.memMb),
      hostFreeMinMb: Math.round(this.hostMin),
      light: {
        n: this.lightMs.length,
        p50: pct(this.lightMs, 50),
        p95: pct(this.lightMs, 95),
        max: max(this.lightMs),
        failures: this.lightFail,
      },
      tripped: this.tripped,
    };
  }
}

/** accumulates the results of one concurrency level over its repetitions */
export class LevelStats {
  requests = 0;
  readonly status = new Map<number, number>();
  readonly codes = new Map<string, number>();
  readonly lat: number[] = [];
  wrong = 0;
  isolation = 0;
  add(status: number, ms: number, code?: string): void {
    this.requests++;
    this.status.set(status, (this.status.get(status) ?? 0) + 1);
    this.lat.push(ms);
    if (code) this.codes.set(code, (this.codes.get(code) ?? 0) + 1);
  }
  get fiveXx(): number {
    let n = 0;
    for (const [s, c] of this.status) if (s >= 500) n += c;
    return n;
  }
  summary(): Record<string, unknown> {
    return {
      requests: this.requests,
      status: Object.fromEntries([...this.status].sort()),
      errorCodes: Object.fromEntries(this.codes),
      fiveXx: this.fiveXx,
      wrongFigures: this.wrong,
      isolationFaults: this.isolation,
      latencyMs: { p50: pct(this.lat, 50), p95: pct(this.lat, 95), max: max(this.lat) },
    };
  }
}

export interface HttpResult {
  status: number;
  ms: number;
  body: unknown;
}

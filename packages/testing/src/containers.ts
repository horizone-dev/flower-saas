import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { MinioContainer, type StartedMinioContainer } from '@testcontainers/minio';
import { GenericContainer } from 'testcontainers';

/**
 * A running integration stack: Postgres 17 + Redis 7 + MinIO. Started once per
 * suite (`--no-file-parallelism`); torn down in `afterAll`. Mirrors the local
 * `docker-compose.yml` services the app actually uses (ARCHITECTURE §54).
 */
export interface TestStack {
  readonly postgres: {
    readonly container: StartedPostgreSqlContainer;
    /** direct connection string (app role posture is applied by the caller) */
    readonly url: string;
    readonly host: string;
    readonly port: number;
  };
  readonly redis: {
    readonly container: StartedRedisContainer;
    readonly url: string;
  };
  readonly minio: {
    readonly container: StartedMinioContainer;
    readonly endpoint: string;
    readonly accessKey: string;
    readonly secretKey: string;
  };
  stop(): Promise<void>;
}

export interface StartTestStackOptions {
  /** which services to start (default: all three) */
  readonly services?: ReadonlyArray<'postgres' | 'redis' | 'minio'>;
  readonly postgresDatabase?: string;
}

// TEMPORARY CI TEST PIN. Review by 2026-12-15 (owner decision, 2026-11-28): re-decide it
// then; it is not extended by default. Recorded in ADR-0013 (amendment of 2026-11-28), evidence in
// docs/decisions/CI-POSTGRES-17-12-PERFORMANCE-EVIDENCE-2026-11.md.
// PostgreSQL 17.12 changes two frozen report query plans (Finding A/B). That regression is
// still OPEN and this pin only keeps CI from seeing it. 17.11 lacks 47 CVE fixes shipped in
// 17.12 (four touch RLS / row visibility), so the isolation probes ALSO run on 17.12 in the
// CI job `isolation-pg17-12`.
// Scope: every suite that calls startTestStack() — apps/api (incl. the cross-tenant and
// branch-isolation probes), apps/worker, apps/realtime, apps/scheduler, the Super Admin Web
// e2e smoke and packages/testing. NOT in scope: @flower/db tests and tooling/spikes/rls,
// which start their own `postgres:17` containers. It does NOT authorise PostgreSQL 17.11 in
// staging or production. Digest = Docker Hub multi-arch index of `postgres:17.11`, verified
// 2026-11-28 (the tag itself is rebuilt by Docker Official Images and is not immutable).
const DEFAULT_POSTGRES_IMAGE =
  'postgres:17.11@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f';

// Only a digest-pinned PostgreSQL 17.x image may replace the default, so an override can
// never re-introduce a floating tag.
const POSTGRES_OVERRIDE_PATTERN = /^postgres:17\.\d+@sha256:[0-9a-f]{64}$/;

/**
 * The PostgreSQL image for the test stack. `FLOWER_TEST_POSTGRES_IMAGE` lets one CI job run
 * the same suites on another 17.x release; anything that is not a digest-pinned
 * `postgres:17.x@sha256:…` reference is rejected (throws), never silently ignored.
 */
export function resolvePostgresImage(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['FLOWER_TEST_POSTGRES_IMAGE'];
  if (override === undefined || override === '') return DEFAULT_POSTGRES_IMAGE;
  if (!POSTGRES_OVERRIDE_PATTERN.test(override)) {
    throw new Error(
      'FLOWER_TEST_POSTGRES_IMAGE must be a digest-pinned postgres:17.x@sha256:<64 hex> reference',
    );
  }
  return override;
}

const IMAGES = {
  redis: 'redis:7',
} as const;

// Both `docker.io/minio/minio` and `quay.io/minio/minio` now return 401
// Unauthorized for anonymous pulls — repository-wide, every tag including
// `latest` (MinIO Community Edition moved to a source-only distribution
// model; neither registry mirror is a viable dependency any more). Instead
// of a prebuilt image, this release is built from pinned upstream source —
// see docker/minio/Dockerfile for the exact commit + build.
const MINIO_RELEASE = 'RELEASE.2025-04-08T15-41-24Z';
const MINIO_IMAGE_TAG = `flower-testing-minio:${MINIO_RELEASE}`;
const MINIO_DOCKER_CONTEXT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docker',
  'minio',
);

let minioImageBuild: Promise<string> | undefined;

/**
 * Builds (once per process) the pinned-source MinIO image and returns its
 * local tag. Docker's own build-layer cache makes every call after the first
 * on a given machine near-instant — no network/registry access beyond the
 * (public, unrelated) Go module proxy and Debian package mirror the
 * Dockerfile itself uses.
 */
function ensureMinioImage(): Promise<string> {
  minioImageBuild ??= GenericContainer.fromDockerfile(MINIO_DOCKER_CONTEXT)
    .build(MINIO_IMAGE_TAG, { deleteOnExit: false })
    .then(() => MINIO_IMAGE_TAG);
  return minioImageBuild;
}

export async function startTestStack(options: StartTestStackOptions = {}): Promise<TestStack> {
  const want = new Set(options.services ?? (['postgres', 'redis', 'minio'] as const));

  const [pg, redis, minio] = await Promise.all([
    want.has('postgres')
      ? new PostgreSqlContainer(resolvePostgresImage())
          .withDatabase(options.postgresDatabase ?? 'flower_test')
          .withUsername('flower')
          .withPassword('flower_test')
          .start()
      : Promise.resolve(undefined),
    want.has('redis') ? new RedisContainer(IMAGES.redis).start() : Promise.resolve(undefined),
    want.has('minio')
      ? ensureMinioImage().then((image) => new MinioContainer(image).start())
      : Promise.resolve(undefined),
  ]);

  const stopped: Array<() => Promise<unknown>> = [];
  if (pg) stopped.push(() => pg.stop());
  if (redis) stopped.push(() => redis.stop());
  if (minio) stopped.push(() => minio.stop());

  return {
    // non-null assertions: presence is guaranteed by `want` — callers request
    // only the services they use.
    postgres: pg
      ? {
          container: pg,
          url: pg.getConnectionUri(),
          host: pg.getHost(),
          port: pg.getPort(),
        }
      : (undefined as never),
    redis: redis ? { container: redis, url: redis.getConnectionUrl() } : (undefined as never),
    minio: minio
      ? {
          container: minio,
          endpoint: `http://${minio.getHost()}:${minio.getMappedPort(9000)}`,
          accessKey: minio.getUsername(),
          secretKey: minio.getPassword(),
        }
      : (undefined as never),
    async stop() {
      await Promise.allSettled(stopped.map((fn) => fn()));
    },
  };
}

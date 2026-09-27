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

const IMAGES = {
  postgres: 'postgres:17',
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
      ? new PostgreSqlContainer(IMAGES.postgres)
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

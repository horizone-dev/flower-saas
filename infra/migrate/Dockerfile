# Migration / seed / role-provisioning runner. SEPARATE from the API image (which carries migration files but no Prisma CLI).
# Build context = repo root. The image is built from a CLEAN, committed tree in CI; at run time it refuses any migration folder that is not in
# infra/migrate/approved-migrations.json (see migrate.mjs).
#
#   docker build -f infra/migrate/Dockerfile -t flower/migrate:<tag> .
#   docker run --rm -e MIGRATION_DATABASE_URL=… flower/migrate:<tag>                                   # check (read-only, the default)
#   docker run --rm -e MIGRATION_DATABASE_URL=… -e MIGRATION_MODE=deploy flower/migrate:<tag>           # apply approved migrations
#   docker run --rm … flower/migrate:<tag> node infra/migrate/provision-db-roles.mjs                    # after deploy
#   docker run --rm … flower/migrate:<tag> node infra/migrate/seed.mjs                                  # idempotent reference data

FROM node:24.20.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Prisma's schema engine needs OpenSSL (without it it falls back to a wrong default and warns)
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
# the frozen lockfile: a lockfile that does not match the manifests fails the build (no silent re-resolution)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages ./packages
COPY apps ./apps
COPY tooling ./tooling
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY turbo.json tsconfig.base.json ./
# @flower/db and every workspace package it depends on (prisma generate + tsc)
RUN pnpm turbo run build --filter "@flower/db..."
COPY infra/migrate ./infra/migrate

FROM build AS runtime
ENV NODE_ENV=production
ENV REPO_ROOT=/repo
# own the tree as the unprivileged user (the runner never needs root)
RUN chown -R node:node /repo
USER node
WORKDIR /repo
ENTRYPOINT []
CMD ["node", "infra/migrate/migrate.mjs"]

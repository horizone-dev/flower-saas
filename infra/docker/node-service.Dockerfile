# Multi-stage build for a Flower SaaS Node runtime role (api / worker / scheduler /
# realtime). Build context = repo root.
#
#   docker build -f infra/docker/node-service.Dockerfile \
#     --build-arg APP=api -t flower/api .
#
# api / worker / scheduler / realtime deploy from ONE image (ARCHITECTURE §55);
# the runtime role is selected by APP.

# ---- base -------------------------------------------------------------------
FROM node:24.20.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# ---- dependencies (cached on the lockfile) ---------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages ./packages
COPY apps ./apps
COPY tooling ./tooling
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- build + prune to a self-contained deploy dir -------------------------
FROM deps AS build
ARG APP
RUN test -n "$APP" || (echo "APP build-arg is required" && exit 1)
COPY . .
# turbo builds the app AND its workspace dependencies in topological order
# (raw `pnpm --filter <app> build` would build only the app, leaving @flower/db,
# @flower/service-runtime, … without a dist/ — ultra-review F3). `deploy --prod`
# then prunes to a self-contained /out with only production dependencies.
RUN pnpm turbo run build --filter "@flower/${APP}" \
    && pnpm --filter "@flower/${APP}" deploy --prod --legacy /out

# ---- runtime --------------------------------------------------------------
FROM node:24.20.0-bookworm-slim AS runtime
ARG APP
ENV NODE_ENV=production
ENV APP=${APP}
# drop privileges (the node image ships a `node` user, uid 1000)
USER node
WORKDIR /app
COPY --chown=node:node --from=build /out /app
EXPOSE 3001 3002 3011 3012
# dumb-init-less: node is PID 1; SIGTERM is handled by installShutdown / Nest
CMD ["node", "dist/main.js"]

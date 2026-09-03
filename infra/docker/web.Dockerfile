# Multi-stage build for a Flower SaaS Next.js web app (super-admin-web / owner-web
# / pos-pwa / customer-web). Build context = repo root. Uses Next's
# `output: 'standalone'` (public/ and .next/static must be copied explicitly).
#
#   docker build -f infra/docker/web.Dockerfile \
#     --build-arg APP=owner-web -t flower/owner-web .

FROM node:24.20.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages ./packages
COPY apps ./apps
COPY tooling ./tooling
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
ARG APP
RUN test -n "$APP" || (echo "APP build-arg is required" && exit 1)
COPY . .
RUN pnpm turbo run build --filter "@flower/${APP}"

FROM node:24.20.0-bookworm-slim AS runtime
ARG APP
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
USER node
WORKDIR /app
# standalone server + the assets Next does NOT bundle into it
COPY --chown=node:node --from=build /repo/apps/${APP}/.next/standalone ./
COPY --chown=node:node --from=build /repo/apps/${APP}/.next/static ./apps/${APP}/.next/static
COPY --chown=node:node --from=build /repo/apps/${APP}/public ./apps/${APP}/public
EXPOSE 3000
# shell form so ${APP} (baked into ENV) expands at runtime
CMD node apps/${APP}/server.js

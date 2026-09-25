# Images for the TypeScript services. Build from the repo root:
#   docker build -f infra/docker/node.Dockerfile --target service --build-arg APP=api .
#   docker build -f infra/docker/node.Dockerfile --target web .
#   docker build -f infra/docker/node.Dockerfile --target migrate .
ARG NODE_IMAGE=node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build
RUN pnpm --filter @prysm/db deploy --legacy /out/migrate
ARG APP
RUN if [ -n "$APP" ]; then pnpm --filter "@prysm/${APP}" deploy --prod --legacy /out/service; fi

# Runtime images need only `node`. The npm/yarn/corepack CLIs bundled in the base image are removed:
# they are unused at runtime and carry their own dependency CVEs.
FROM ${NODE_IMAGE} AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
WORKDIR /app

# One-shot migration runner: @prysm/db with drizzle-kit, run as prysm_owner (compose "db-migrate").
FROM runtime AS migrate
COPY --from=build --chown=node:node /out/migrate .
USER node
CMD ["node_modules/.bin/drizzle-kit", "migrate"]

FROM runtime AS service
COPY --from=build --chown=node:node /out/service .
USER node
CMD ["node", "--import", "@prysm/platform/otel", "dist/main.js"]

FROM runtime AS web
ENV PORT=3001 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
CMD ["node", "apps/web/server.js"]

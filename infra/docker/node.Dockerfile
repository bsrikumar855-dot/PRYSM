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

# One-shot migration runner (runs as prysm_owner; see compose "db-migrate").
FROM build AS migrate
WORKDIR /repo/packages/db
USER node
CMD ["node_modules/.bin/drizzle-kit", "migrate"]

FROM build AS service-deploy
ARG APP
RUN test -n "$APP" && pnpm --filter "@prysm/${APP}" deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS service
ENV NODE_ENV=production
WORKDIR /app
COPY --from=service-deploy --chown=node:node /out .
USER node
CMD ["node", "--import", "@prysm/platform/otel", "dist/main.js"]

FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production PORT=3001 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
CMD ["node", "apps/web/server.js"]

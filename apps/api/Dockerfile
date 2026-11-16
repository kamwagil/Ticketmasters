# Build from the repository root:  docker build -f apps/api/Dockerfile -t ctp-api .
FROM node:22-alpine AS build
WORKDIR /repo
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w @ctp/api --include-workspace-root --no-audit --no-fund
COPY apps/api apps/api
RUN cd apps/api && npx prisma generate && npx nest build

FROM node:22-alpine AS runtime
WORKDIR /repo
RUN apk add --no-cache openssl tini && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/prisma apps/api/prisma
COPY --from=build /repo/apps/api/package.json apps/api/package.json
WORKDIR /repo/apps/api
RUN mkdir -p storage && chown -R app:app storage
USER app
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=4 CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
# tini forwards SIGTERM so in-flight requests and jobs finish before exit (graceful shutdown).
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

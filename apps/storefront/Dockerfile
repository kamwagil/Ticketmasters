# Build from the repository root:  docker build -f apps/storefront/Dockerfile -t ctp-storefront .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/storefront/package.json apps/storefront/
RUN npm ci -w @ctp/storefront --include-workspace-root --no-audit --no-fund
COPY apps/storefront apps/storefront
ENV NEXT_TELEMETRY_DISABLED=1
# The /api proxy target is fixed at build time (Next.js rewrites). Override with --build-arg.
ARG API_URL=http://api:4000
ENV API_URL=$API_URL
RUN cd apps/storefront && npx next build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/storefront/.next/standalone ./
COPY --from=build /repo/apps/storefront/.next/static apps/storefront/.next/static
COPY --from=build /repo/apps/storefront/public apps/storefront/public
USER app
EXPOSE 3100
CMD ["node", "apps/storefront/server.js"]

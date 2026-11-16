# Build from the repository root:  docker build -f apps/admin/Dockerfile -t ctp-admin .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/admin/package.json apps/admin/
RUN npm ci -w @ctp/admin --include-workspace-root --no-audit --no-fund
COPY apps/admin apps/admin
ENV NEXT_TELEMETRY_DISABLED=1
# The /api proxy target is fixed at build time (Next.js rewrites). Override with --build-arg.
ARG API_URL=http://api:4000
ENV API_URL=$API_URL
RUN cd apps/admin && npx next build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/admin/.next/standalone ./
COPY --from=build /repo/apps/admin/.next/static apps/admin/.next/static
COPY --from=build /repo/apps/admin/public apps/admin/public
USER app
EXPOSE 3000
CMD ["node", "apps/admin/server.js"]

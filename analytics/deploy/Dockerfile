FROM node:22-slim AS web
RUN corepack enable
WORKDIR /web
COPY analytics/web/package.json analytics/web/pnpm-lock.yaml analytics/web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY analytics/web/ ./
RUN pnpm run build
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY analytics/package.json analytics/pnpm-lock.yaml analytics/pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY analytics/src ./src
COPY analytics/test ./test
COPY --from=web /web/dist ./web/dist
EXPOSE 30110
CMD ["node","src/server.mjs"]

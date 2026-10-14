# syntax=docker/dockerfile:1
# =============================================================================
# run_msa_analysis — backend (Node) + frontend (React) in ONE image.
#
# From the platform template `plantillas/integracion/docker/tool.Dockerfile`
# (core repo). Changed only where the template says <-- EDITA:
#   · paths: this is a monorepo, the tool lives in tools/run-msa-analysis/
#   · no backend build stage: the backend is plain JavaScript, runs as-is
#   · CMD: node src/server.js
#
# Build context = REPO ROOT. In Railway, the project of this tool sets
#   RAILWAY_DOCKERFILE_PATH = docker/run_msa_analysis.Dockerfile
# and leaves Root Directory EMPTY (repo root) — see docs/DESPLIEGUE.md.
#
# One origin serves everything:  /  the SPA  ·  /api/*  the API  ·  /auth/*  OIDC
# =============================================================================

ARG NODE_IMAGE=node:22-slim

# --- 1. Frontend (React) -----------------------------------------------------
FROM ${NODE_IMAGE} AS web
# Without this, Corepack asks before downloading pnpm and a non-interactive
# build hangs until the timeout without saying why.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /web
RUN corepack enable

# Manifests first, code after: touching a .tsx must not reinstall the tree.
# pnpm-workspace.yaml carries `allowBuilds: esbuild` (pnpm 11 blocks it otherwise).
COPY tools/run-msa-analysis/web/package.json tools/run-msa-analysis/web/pnpm-lock.yaml tools/run-msa-analysis/web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tools/run-msa-analysis/web/ ./
# VITE_* is BAKED into the bundle and public. Only URLs here, never a key.
ARG VITE_DASHBOARD_URL=""
RUN VITE_DASHBOARD_URL="${VITE_DASHBOARD_URL}" pnpm run build

# --- 2. Runtime --------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable

# Production dependencies only. Nothing in the container may depend on a
# devDependency.
COPY tools/run-msa-analysis/package.json tools/run-msa-analysis/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY tools/run-msa-analysis/src ./src

# The compiled frontend, and NOTHING else from the frontend.
COPY --from=web /web/dist ./web/dist
ENV UI_DIST_DIR=/app/web/dist

# A DEFAULT, not a rule: Railway injects its own PORT and the server reads it.
# 8109 is this tool's `localPort` in the core's deployments.json.
ENV PORT=8109
EXPOSE 8109

# Liveness, not readiness: does the PROCESS answer. It never touches the
# database — a Postgres blip must not restart a healthy container in a loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8109)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]

# run_msa_analysis — Gage R&R / MSA study analysis
# Zero npm dependencies (pure Node). Build context must be the repo root:
#   docker build -f docker/run_msa_analysis.Dockerfile -t run_msa_analysis .
#
# Runs tools/run-msa-analysis/src/server.js — an HTTP wrapper around the
# same handler logic (same validation, same math, same emitted events):
#   GET  /health
#   POST /events   (body = full event envelope, see tools/run-msa-analysis/demo/*.json)
#
# Run:
#   docker run --rm -p 8082:8082 run_msa_analysis
#   docker run --rm -p 8082:8082 -e INBOUND_API_KEY=xxx run_msa_analysis
#
# The one-shot CLI form (node src/handler.js <file>) still works if you
# exec into the container or run it outside Docker — this image just
# defaults to the HTTP service.

FROM node:18-alpine

WORKDIR /app

COPY tools/run-msa-analysis/package.json ./package.json
COPY tools/run-msa-analysis/src ./src
COPY tools/run-msa-analysis/demo ./demo
# src/public/index.html (the frontend served at GET /) is included
# automatically since it lives under src/, copied above.

ENV PORT=8082
EXPOSE 8082

CMD ["node", "src/server.js"]

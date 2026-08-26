# calculate_cpk_ppk — Cpk/Ppk process capability analysis
# Zero npm dependencies (pure Node). Build context must be the repo root:
#   docker build -f docker/calculate_cpk_ppk.Dockerfile -t calculate_cpk_ppk .
#
# Runs tools/calculate-cpk-ppk/src/server.js — an HTTP wrapper around the
# same handler logic (same validation, same math, same emitted events):
#   GET  /health
#   POST /events   (body = full event envelope, see tools/calculate-cpk-ppk/demo/*.json)
#
# Run:
#   docker run --rm -p 8081:8081 calculate_cpk_ppk
#   docker run --rm -p 8081:8081 -e INBOUND_API_KEY=xxx calculate_cpk_ppk
#
# The one-shot CLI form (node src/handler.js <file>) still works if you
# exec into the container or run it outside Docker — this image just
# defaults to the HTTP service.

FROM node:18-alpine

WORKDIR /app

COPY tools/calculate-cpk-ppk/package.json ./package.json
COPY tools/calculate-cpk-ppk/src ./src
COPY tools/calculate-cpk-ppk/demo ./demo
# src/public/index.html (the frontend served at GET /) is included
# automatically since it lives under src/, copied above.

ENV PORT=8081
EXPOSE 8081

CMD ["node", "src/server.js"]

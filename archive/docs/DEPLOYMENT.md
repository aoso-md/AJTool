# Deployment runbook

The one document to open when something is offline, or when [EXTERNAL_ADMIN]' side
needs to be wired up. Everything here is a real step someone has to
take — nothing aspirational.

---

## 0. The mental model (read this first)

Four separate things, each with its own access rules. Most of the
confusion in this project came from treating them as one thing.

| Layer | What it is | Who can see it | Controlled by |
|---|---|---|---|
| **GitHub repo** | the source code | public since the repo was opened | repo visibility |
| **GHCR image** | the built container | public once the *package* is made public — a separate setting from the repo | package visibility |
| **Railway service** | a running container with a URL | anyone with the URL can hit `/` and `/health` | the service's Source setting |
| **`INBOUND_API_KEY`** | the key on `/events` and `/reports` | only whoever holds the key | env var on the service |

A Railway service shows **offline** when nothing is deployed into it.
That is a Source problem, never a code problem. A service with no Source
connected will read offline forever, no matter how healthy the same code
is in someone else's Railway project.

---

## 1. Which model are we running?

**Model B (recommended, and what the GHCR pipeline is built for)** — the
image lives in [EXTERNAL_ADMIN]' Railway. Matches how his other teams' tools are
set up, and removes Angel's Railway billing as a single point of failure.

**Model A** — [EXTERNAL_ADMIN] calls Angel's hosted URLs directly. Simpler to explain,
but everything dies if Angel's Railway lapses.

The rest of this document assumes **Model B**, with the Model A steps in
section 6.

---

## 2. Publish the images (Angel, once per code change)

1. Push to `main`. The workflow in `.github/workflows/docker-publish.yml`
   runs the test suite, then builds and pushes both images.
2. Open `https://github.com/<owner>/AJTool/actions` **in a web browser**
   (not PowerShell) and confirm both jobs are green.
3. **One-time only:** make each package public.
   GitHub → your profile → **Packages** → `calculate_cpk_ppk` →
   **Package settings** → **Change visibility** → **Public**. Repeat for
   `run_msa_analysis`.
   This is a *package* setting. It is independent of the repo being
   public, and it is the step that lets [EXTERNAL_ADMIN] pull without any credentials.

The published references are:

```
ghcr.io/<owner>/calculate_cpk_ppk:latest
ghcr.io/<owner>/run_msa_analysis:latest
```

Each build also publishes a `:<commit-sha>` tag, so a bad deploy can be
pinned back to a known-good build instead of guessing.

---

## 3. Wire up [EXTERNAL_ADMIN]' Railway (his side, once per service)

For each of his two currently-empty services:

1. Open the service → **Settings** → **Source**.
   *If it says "No source connected", that is exactly why it reads
   offline.*
2. Choose **Deploy from Docker Image**.
3. Paste the image reference for that service (section 2).
4. **Variables** tab → add:
   - `INBOUND_API_KEY` — the key his platform will send as `x-api-key`.
     It must match on both sides character for character, or every call
     comes back `401`.
   - `PORT` — normally auto-detected (8081 for Cpk/Ppk, 8082 for MSA).
     Set it explicitly only if Railway's healthcheck fails.
5. Deploy. Railway healthchecks `/`, which the services answer with 200,
   so the status flips to **online** on its own.

**Verify, in this order** — each step rules out one cause:

| Check | Expected | If it fails |
|---|---|---|
| Open the service URL in a browser | the tool's form loads | the container isn't running — check Deploy logs |
| `GET /health` | `{"ok":true,...}` | same as above |
| `POST /events` with the key | a real result | if `401`, the keys don't match |
| `GET /reports` with the key | the call you just made | persistence isn't wired — section 4 |

---

## 4. The database (optional, but it's what makes history real)

Without it, `/reports` still works — it serves the last 100 calls from
memory and honestly labels itself `memory (volatile)`. A restart wipes
it. With it, history survives restarts and `/health` reports
`postgres (durable)`.

1. In Railway, open the project → **New** → **Database** →
   **Add PostgreSQL**.
2. Attach it to each service that should write history (both tools, and
   the bus-proxy if it's deployed). Railway injects `DATABASE_URL`
   automatically — nothing to copy by hand.
3. Redeploy the service.
4. Confirm: `GET /health` → `persistence.tier` should read
   `postgres (durable)`.

The tables are created automatically on first boot. The schema is
written out in [`db/schema.sql`](../db/schema.sql) so it can be reviewed
or applied by hand — one `invocations` table shared by both tools
(separated by the `tool` column) and one `bus_events` table for the
proxy.

One Postgres instance is enough for all three services.

---

## 5. Running and testing locally

No `npm install` needed for anything below — with no `DATABASE_URL` set,
the services have zero dependencies.

```powershell
# from the repo root
node test\run-tests.js                          # full suite: math, contract, HTTP

node tools\calculate-cpk-ppk\src\server.js      # http://localhost:8081
node tools\run-msa-analysis\src\server.js       # http://localhost:8082
node bus-proxy\server.js                        # http://localhost:8787

# one-shot CLI, no server
node tools\calculate-cpk-ppk\src\handler.js tools\calculate-cpk-ppk\demo\capable-case.json
```

The test suite must pass before pushing — CI runs the same command and
refuses to publish images if it fails.

---

## 6. Model A fallback (Angel hosts, [EXTERNAL_ADMIN] calls in)

1. Angel's Railway needs an active payment method (the trial expiring is
   what took the services down before — the containers were fine, the
   platform stopped them).
2. Deploy each service **from its own folder**, never from the repo root:
   ```powershell
   cd tools\calculate-cpk-ppk
   railway link      # pick the matching service explicitly
   railway up
   ```
   Deploying from the root fails (no root `package.json`), and running
   `railway up` while linked to the wrong service overwrites that
   service — this has already happened once with the bus-proxy. Always
   confirm the link target before `up`.
3. Set `INBOUND_API_KEY` on each service and give [EXTERNAL_ADMIN] the URLs plus the
   paths: `POST /events`, `GET /health`, `GET /reports`.

---

## 7. Troubleshooting by symptom

**"It shows offline on [EXTERNAL_ADMIN]' Railway but fine on mine."**
Two different Railway projects. His service has no Source connected.
Ask for a screenshot of Settings → Source; if it says "No source
connected", section 3 is the whole fix.

**Every call returns 401.**
`INBOUND_API_KEY` on the service doesn't match the key his platform
sends. Compare them character by character — a trailing space is enough.

**The service was up and then died.**
Check the deploy logs. `Starting Container` → `Stopping Container` →
`SIGTERM` with no application error means the platform stopped it
(expired trial, quota), not a crash. An actual crash shows a stack trace.

**`/reports` is empty after a redeploy.**
Expected if `persistence.tier` says `memory (volatile)` — memory is
wiped on restart by definition. Attach Postgres (section 4).

**`/health` says `postgres` but `durable: false`.**
`DATABASE_URL` is set and the database is unreachable; the `detail`
field carries the actual error. The service deliberately stays up and
serves from memory rather than failing calls.

**SSL / trust-relationship error on a custom domain.**
DNS or certificate provisioning is still pending on that domain, not a
code issue. Check the domain's status in the Railway dashboard.

---

## 8. Still open (needs [EXTERNAL_ADMIN] / Demian, not code)

- Confirm Model A vs Model B as the official integration.
- `MSA_NOT_ACCEPTABLE` is emitted but **not** an official event yet —
  arguably the most important output for nonconformance routing.
- The "capable" Cpk case has no official output event at all; only
  `CAPABILITY_BELOW_TARGET` is confirmed.
- The bus-proxy has never had a real ORCA API base URL or outbound key,
  so it has only ever run in `LOCAL` mode.
- Rotate `INBOUND_API_KEY` once the final setup is confirmed working —
  it has been shared in plain text over WhatsApp and in screenshots.

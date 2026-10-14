// src/platform/app.js
// -----------------------------------------------------------------------------
// HTTP surface of a federated tool, wired in the order the platform's SSO
// template (plantillas/integracion/sso/ejemplo-servidor.js) requires:
//
//   1. /health and /ready OPEN, before anything else. The container
//      healthcheck and the dashboard tiles have no session. A /health behind
//      auth is the #1 cause of "my tool is up but the dashboard shows it grey".
//   2. attachCaller — resolves who is calling, rejects nobody.
//   3. /auth/* — the OIDC handshake (inert until OIDC_ISSUER is set).
//   4. /api/* — requires a credential: session cookie (human) or x-api-key
//      matching TOOL_API_KEY (machine). Answers 401 JSON, never a 302.
//   5. The SPA at /, same origin, so the session cookie is first-party and CORS
//      never enters the picture.
// -----------------------------------------------------------------------------
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  attachCaller,
  authEnabled,
  authMode,
  gateway,
  requireCaller,
  requireBrowserSession,
  requireRole,
  describeSession
} from './auth/index.js';

/** Domain roles (see auth/role-mapping.js) allowed to record and publish studies. */
export const QUALITY_ROLES = ['QualityEngineer', 'QualityManager', 'TechnicalAuthority', 'QualityDirector'];

/**
 * Who is acting, taken from the VERIFIED caller — never from the request body.
 * ISO 9001:2015 7.5.2 / 7.5.3.2: the person who performed a study must be
 * identified and that identity retained. A name typed into a form is not
 * identification. In open mode this is the synthetic `local-dev` caller, and the
 * UI shows a permanent warning saying so.
 */
export function actorOf (caller) {
  if (!caller) return null;
  return {
    kind: caller.kind,
    ref: caller.subject ?? null,
    name: caller.displayName ?? null,
    role: caller.role ?? null
  };
}

export function createApp ({ tool, config, core, store, poller, publisher, registerRoutes, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  // Behind Railway's proxy: real client IP and protocol.
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));

  // ── 1. Health: ALWAYS open ─────────────────────────────────────────────────
  // Liveness only. It must not touch the database: if it did, a momentary
  // Postgres blip would make Railway restart a perfectly healthy container.
  app.get('/health', (req, res) => {
    res.set('cache-control', 'no-store');
    res.json({ status: 'ok', tool: tool.id, version: tool.version, time: new Date().toISOString() });
  });

  // Readiness may look at dependencies. It never exposes secrets.
  app.get('/ready', async (req, res) => {
    res.set('cache-control', 'no-store');
    const storeReady = await store.ping();
    const p = poller.status();
    res.status(storeReady ? 200 : 503).json({
      status: storeReady ? 'ready' : 'not_ready',
      tool: tool.id,
      version: tool.version,
      auth: authMode,
      persistence: store.tier(),
      publish: publisher.mode,
      poller: { state: p.state, enabled: p.enabled, lastSuccessAt: p.lastSuccessAt, cursor: p.cursor }
    });
  });

  app.use(attachCaller);

  // ── 2. OIDC handshake ──────────────────────────────────────────────────────
  app.get('/auth/me', (req, res) => {
    res.set('cache-control', 'no-store');
    const payload = describeSession(req);
    res.status(payload.authenticated || !authEnabled ? 200 : 401).json(payload);
  });
  if (authEnabled) {
    app.get('/auth/login', (req, res) => gateway.handleRoute(req, res, 'login'));
    app.get('/auth/callback', (req, res) => gateway.handleRoute(req, res, 'callback'));
    app.get('/auth/logout', (req, res) => gateway.handleRoute(req, res, 'logout'));
  }

  // ── 3. API ─────────────────────────────────────────────────────────────────
  const api = express.Router();
  api.use(requireCaller);

  // Everything an operator (or Carlos, or a reviewer) needs to know about how
  // this instance is configured and whether it is actually receiving events.
  // No secrets: the core key is reported as configured/not, never echoed.
  api.get('/status', (req, res) => {
    res.set('cache-control', 'no-store');
    res.json({
      tool: {
        id: tool.id,
        name: tool.name,
        clause: tool.clause,
        version: tool.version,
        consumes: tool.consumes,
        produces: tool.produces
      },
      auth: authMode,
      caller: actorOf(req.caller),
      persistence: store.tier(),
      publish: { mode: publisher.mode },
      core: { configured: core.configured, baseUrl: core.baseUrl },
      poller: poller.status()
    });
  });

  // Who may change records and criteria: services and open-mode callers (as in
  // requireRole) or a person holding one of the quality roles. Exposed to the UI
  // as `canEdit` so it can say "solo lectura" instead of failing on submit.
  const canEdit = (req) => Boolean(req.caller) && (
    req.caller.kind === 'service' || req.caller.kind === 'open' ||
    (req.caller.roles || []).some((role) => QUALITY_ROLES.includes(role))
  );

  registerRoutes(api, { requireQuality: requireRole(...QUALITY_ROLES), actorOf, canEdit });

  app.use('/api', api);
  // Unknown /api is JSON 404, BEFORE the SPA fallback, so a typo'd endpoint
  // never receives the HTML shell with a 200.
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', path: req.originalUrl }));

  // ── 4. The SPA, same origin ────────────────────────────────────────────────
  // Resolved to an absolute path: sendFile refuses relative ones, and the
  // documented local command sets UI_DIST_DIR=web/dist.
  const uiDir = config.uiDistDir ? path.resolve(config.uiDistDir) : null;
  if (uiDir && existsSync(path.join(uiDir, 'index.html'))) {
    // Assets open and cached forever (hashed names). A 302 to the IdP in
    // response to a .js file is followed by nobody and breaks the page load.
    app.use(express.static(uiDir, { index: false, maxAge: '1y', immutable: true }));
    app.get(/.*/, requireBrowserSession, (req, res) => {
      res.set('cache-control', 'no-store');
      res.sendFile(path.join(uiDir, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => res.json({
      tool: tool.id,
      status: 'ok',
      ui: 'not built — set UI_DIST_DIR to the frontend dist/ folder',
      see: ['/health', '/ready', '/api/status']
    }));
  }

  // Malformed JSON is the caller's error, not ours.
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    log.error?.(`[http] ${req.method} ${req.originalUrl}: ${error?.stack || error}`);
    return res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

/** Startup banner: the first lines of the Railway deploy log answer "what is running and how". */
export function printBanner ({ tool, config, core, store, publisher, log = console }) {
  const lines = [
    `${tool.id} v${tool.version} listening on :${config.port}`,
    `  ISO clause      ${tool.clause}`,
    `  auth            ${authMode}${authMode === 'open' ? '  (OIDC_ISSUER not set — development only)' : ''}`,
    `  machine plane   ${process.env.TOOL_API_KEY ? 'TOOL_API_KEY set' : 'TOOL_API_KEY not set'}`,
    `  core            ${core.configured ? core.baseUrl : 'NOT CONFIGURED — receives nothing from the platform'}`,
    `  consumes        ${tool.consumes.join(', ')}`,
    `  publishes       ${tool.produces.join(', ')}  [mode: ${publisher.mode}]`,
    `  persistence     ${store.tier().tier}${store.tier().durable ? ' (durable)' : ' (volatile)'}`,
    `  ui              ${config.uiDistDir || 'not served (UI_DIST_DIR unset)'}`
  ];
  for (const line of lines) log.info?.(line);
}

export default { createApp, printBanner, actorOf, QUALITY_ROLES };

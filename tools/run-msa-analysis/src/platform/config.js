// src/platform/config.js
// -----------------------------------------------------------------------------
// Runtime configuration, read once from the environment. Every variable is
// documented in `.env.example` next to package.json.
//
// PORT: Railway injects its own and we MUST honour it. The tool's `localPort`
// is only the default for local runs — and it matches `localPort` in the
// core's deployments.json, so the core's PLATFORM_LOCAL_TOOLS=true mode finds
// this service on a developer machine without extra config.
// -----------------------------------------------------------------------------

function clampInt (raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function loadConfig (env = process.env, tool) {
  return {
    port: clampInt(env.PORT, tool.localPort, 1, 65535),
    coreUrl: env.ISOTOOLS_API_URL?.trim() || null,
    coreKey: env.ISOTOOLS_API_KEY?.trim() || null,
    publishMode: env.CORE_PUBLISH?.trim().toLowerCase() === 'live' ? 'live' : 'shadow',
    pollEnabled: env.POLL_ENABLED?.trim().toLowerCase() !== 'false',
    pollIntervalMs: clampInt(env.POLL_INTERVAL_MS, 5_000, 1_000, 600_000),
    databaseUrl: env.DATABASE_URL?.trim() || null,
    uiDistDir: env.UI_DIST_DIR?.trim() || null
  };
}

export default { loadConfig };

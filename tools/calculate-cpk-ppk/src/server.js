// src/server.js — entry point (`node src/server.js`)
// -----------------------------------------------------------------------------
// Builds the tool from its parts and starts two things:
//   1. the HTTP service (health, auth, API, UI) on process.env.PORT
//   2. the subscription poller that pulls work from the ORCA core
//
// SIGTERM (Railway redeploys) stops the poller first, so a batch in progress
// finishes and its cursor is saved, then closes HTTP and the database.
// -----------------------------------------------------------------------------
import { loadConfig } from './platform/config.js';
import { createStore } from './platform/store.js';
import { createCoreClient } from './platform/core-client.js';
import { createPoller, createPublisher } from './platform/poller.js';
import { createApp, printBanner } from './platform/app.js';
import { TOOL, createCapabilityTool } from './tool.js';

const log = console;
const config = loadConfig(process.env, TOOL);

const store = await createStore({ databaseUrl: config.databaseUrl, log });
const core = createCoreClient({ baseUrl: config.coreUrl, apiKey: config.coreKey });
const publisher = createPublisher({ core, mode: config.publishMode, log });
const domain = createCapabilityTool({ store, core, publisher, log });

const poller = createPoller({
  toolId: TOOL.id,
  consumes: TOOL.consumes,
  core,
  store,
  processEvent: domain.processEvent,
  beforeTick: domain.beforeTick,
  intervalMs: config.pollIntervalMs,
  enabled: config.pollEnabled,
  log
});

const app = createApp({ tool: TOOL, config, core, store, poller, publisher, registerRoutes: domain.registerRoutes, log });

const server = app.listen(config.port, () => {
  printBanner({ tool: TOOL, config, core, store, publisher, log });
  poller.start();
});

async function shutdown (signal) {
  log.info(`${signal} received — stopping poller, then HTTP`);
  await poller.stop();
  server.close(() => {
    store.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

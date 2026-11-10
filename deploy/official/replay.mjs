import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { decisionErrors } from './check-transition-decision.mjs';

const supported = new Map([
  ['calculate_cpk_ppk', () => import('../../tools/calculate-cpk-ppk/src/tool.js')],
  ['run_msa_analysis', () => import('../../tools/run-msa-analysis/src/tool.js')]
]);

export async function replayStatus(store, tool) {
  return store.executeTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const name = `subscription:${tool}`;
    const { rows: [cursor] } = await client.query(
      'SELECT seq::text, generation::text FROM public.consumer_cursors WHERE name=$1', [name]
    );
    const { rows: outcomes } = await client.query(
      'SELECT outcome, count(*)::text AS count FROM public.event_inbox WHERE tool=$1 AND consumer=$2 GROUP BY outcome ORDER BY outcome',
      [tool, name]
    );
    const { rows: [outbox] } = await client.query(
      "SELECT count(*) FILTER (WHERE mode='shadow' AND state='shadow_recorded' AND attempts=0)::text AS shadow, count(*) FILTER (WHERE mode<>'shadow' OR state<>'shadow_recorded' OR attempts<>0)::text AS other FROM public.event_outbox WHERE tool=$1",
      [tool]
    );
    return { tool, cursor: cursor ?? null, outcomes, outbox };
  });
}

async function scanLane({ core, cutoff, page, normalize, sequence, maxPages = 1000 }, visit) {
  let after = '0';
  let eventsRead = 0;
  const boundary = sequence(cutoff);
  for (let i = 0; BigInt(after) < BigInt(boundary) && i < maxPages; i++) {
    const { events } = await page(core, after);
    if (!Array.isArray(events) || !events.length) break;
    for (const raw of events) {
      const event = normalize(raw);
      const next = sequence(event.sourceSeq);
      if (BigInt(next) <= BigInt(after)) throw new Error('non_monotonic_source_page');
      if (BigInt(next) > BigInt(boundary)) break;
      after = next;
      eventsRead++;
      if (visit) await visit(event);
    }
    if (BigInt(after) < BigInt(boundary) && events.length < 100) break;
  }
  return { cutoff: boundary, lastSourceSeq: after, events: eventsRead, sourceReached: after === boundary };
}

export async function reconcile(args) {
  const { store, tool, lane } = args;
  const counts = { missing: 0, mismatched: 0, processed: 0, ignored: 0, rejected: 0, unresolved: 0, missingStudy: 0 };
  const source = await scanLane(args, async (event) => {
      // Compare the canonical event hash and the committed outcome, without
      // returning payloads, IDs or error messages from the database.
      const entry = await store.getInboxRecord(tool, event.eventId);
      if (!entry) counts.missing++;
      else if (entry.inputHash !== event.inputHash || entry.consumer !== lane) counts.mismatched++;
      else if (['processed', 'ignored', 'rejected'].includes(entry.outcome)) {
        counts[entry.outcome]++;
        if (entry.studyId) {
          const study = await store.getStudy(entry.studyId);
          if (study?.tool !== tool || study.inputEventId !== event.eventId) counts.missingStudy++;
        }
        if (lane.startsWith('subscription:') && entry.outcome === 'processed' && !entry.studyId) counts.missingStudy++;
      } else counts.unresolved++;
  });
  const cursor = await store.getCursorState(lane);
  const reached = source.sourceReached && (source.cutoff === '0' || (cursor && BigInt(cursor.seq) >= BigInt(source.cutoff)));
  return {
    lane, ...source, confirmedCursor: cursor?.seq ?? null, ...counts,
    complete: Boolean(reached && !counts.missing && !counts.mismatched && !counts.unresolved && !counts.missingStudy)
  };
}

async function main() {
  const [command, tool, revision] = process.argv.slice(2);
  if (!['init', 'status', 'source', 'reconcile'].includes(command) || !supported.has(tool)) throw new Error('invalid_command');
  const { TOOL, SPEC_EVENT } = await supported.get(tool)();
  const path = `../../tools/${tool.replaceAll('_', '-')}/src/platform/`;
  const lanes = [
    { name: `subscription:${tool}`, types: TOOL.consumes, page: (client, after) => client.subscription(tool, after, 100) }
  ];
  if (SPEC_EVENT) lanes.push({
    name: `specs:${SPEC_EVENT}`, types: [SPEC_EVENT],
    page: (client, after) => client.query({ sinceSeq: after, types: [SPEC_EVENT], limit: 100 })
  });
  let sourceArgs;
  if (command === 'source' || command === 'reconcile') {
    const { createCoreClient } = await import(path + 'core-client.js');
    const { fromCore } = await import(path + 'ies.js');
    const { inboxEvent, sequenceText } = await import(path + 'reliability.js');
    const core = createCoreClient({ baseUrl: process.env.ISOTOOLS_API_URL, apiKey: process.env.ISOTOOLS_API_KEY });
    if (!core.configured) throw new Error('authorized_core_connection_required');
    sourceArgs = { core, normalize: raw => inboxEvent(fromCore(raw)), sequence: sequenceText };
  }
  if (command === 'source') {
    const results = [];
    for (const lane of lanes) {
      const cutoff = await sourceArgs.core.latestMaxSeq(lane.types) ?? '0';
      if (String(cutoff) === '0' && (await lane.page(sourceArgs.core, '0')).events.length) {
        throw new Error('source_tip_inconsistent');
      }
      results.push({ lane: lane.name, ...await scanLane({ ...sourceArgs, cutoff, page: lane.page }) });
    }
    const complete = results.every(lane => lane.sourceReached);
    console.log(JSON.stringify({ tool, lanes: results, complete }));
    if (!complete) process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('database_url_required');
  const environment = process.env.AJTOOL_ENVIRONMENT || 'production';
  let decision;
  if (command !== 'status') {
    decision = JSON.parse(process.env.AJTOOL_DATA_DECISION_JSON || 'null');
    const errors = decisionErrors(decision, { tool, revision });
    if (errors.length || decision.action !== 'rebuild_from_core') throw new Error('approved_replay_decision_required');
    if (process.env.CORE_PUBLISH !== 'shadow') throw new Error('shadow_required');
  }
  if (command === 'init') {
    if (process.env.POLL_ENABLED !== 'false') throw new Error('pollers_must_be_disabled');
    const database = new URL(process.env.DATABASE_URL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(database.hostname);
    if (!local || environment === 'production') {
      const { targetDescriptor, PROJECT_REF } = await import('../../db/review/check-supabase-target.mjs');
      const target = targetDescriptor(database.href);
      const role = target.mode === 'session' ? `ajtool_service.${PROJECT_REF}` : 'ajtool_service';
      if (environment !== 'production' || decodeURIComponent(database.username) !== role || database.pathname !== '/postgres') {
        throw new Error('approved_runtime_database_required');
      }
      const git = { cwd: new URL('../../', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
      if (execFileSync('git', ['rev-parse', 'HEAD'], git).trim() !== revision) throw new Error('revision_not_checked_out');
      execFileSync('git', ['diff', '--quiet', 'HEAD', '--'], git);
    }
  }
  const { createStore } = await import(path + 'store.js');
  const store = await createStore({ databaseUrl: process.env.DATABASE_URL, databaseRequired: true, failFast: true, log: {} });
  try {
    if (command === 'status') {
      console.log(JSON.stringify(await replayStatus(store, tool)));
      return;
    }
    if (command === 'init') {
      console.log(JSON.stringify(await store.initializeReplay(tool, environment)));
      return;
    }
    const results = [];
    for (const [index, lane] of lanes.entries()) {
      results.push(await reconcile({
        ...sourceArgs, store, tool, lane: lane.name,
        cutoff: index === 0 ? decision.sourceCutoff : decision.specCutoff, page: lane.page
      }));
    }
    const status = await replayStatus(store, tool);
    const complete = results.every(lane => lane.complete) && status.outbox.other === '0';
    console.log(JSON.stringify({ ...status, lanes: results, complete }));
    if (!complete) process.exitCode = 1;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    console.error('Replay command refused or unavailable. Check the target, approval, shadow mode, cursor and authorized credentials.');
    process.exitCode = 1;
  });
}

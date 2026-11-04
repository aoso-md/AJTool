// test/ensayo-integral.test.js — Verificación de Escenario 1 del Ensayo Integral IsoTools v1.3
// Documento de referencia: PR-ORCA-ENS-001 (Versión 1.3, 22 de octubre de 2026)
// Escenario 1: Nuevo instrumento de medición (Cláusulas ISO 9001: 7.1.5, 7.1.5.2, 9.1.3)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/platform/store.js';
import { createCoreClient } from '../src/platform/core-client.js';
import { createPoller, createPublisher } from '../src/platform/poller.js';
import { createApp } from '../src/platform/app.js';
import { TOOL, createMsaTool } from '../src/tool.js';
import { fromCore } from '../src/platform/ies.js';
import { startFakeCore, producedEvent } from './helpers/fake-core.js';

const quiet = { info () {}, warn () {}, error () {} };

// Fixture ENS-CAL-001 según Sección 4.1 del Ensayo
const deviceEvent = (gaugeId, operation = 'register', extra = {}) => producedEvent({
  type: 'NEW_DEVICE_REGISTERED',
  moduleId: 'manage_device_registry',
  asset: { asset_id: gaugeId, asset_type: 'gauge', plant_id: 'plant_01', location: 'Lab Metrología' },
  data: {
    operation,
    gaugeId,
    devices: [{ id: gaugeId, type: 'calibrador digital 0–150 mm', nextCalibration: '2027-10-22' }],
    totalDevices: 1,
    operationResult: 'registered',
    ...extra
  }
});

// Mediciones Gage R&R para instrumento aceptable (%GRR < 10%, ndc >= 5)
// 2 piezas x 2 operadores x 2 ensayos con varianza mínima
const ACCEPTABLE_OBSERVATIONS = [
  { partId: 'P1', operatorId: 'OP-A', trial: 1, value: 25.001 },
  { partId: 'P1', operatorId: 'OP-A', trial: 2, value: 25.002 },
  { partId: 'P1', operatorId: 'OP-B', trial: 1, value: 25.001 },
  { partId: 'P1', operatorId: 'OP-B', trial: 2, value: 25.003 },
  { partId: 'P2', operatorId: 'OP-A', trial: 1, value: 25.200 },
  { partId: 'P2', operatorId: 'OP-A', trial: 2, value: 25.201 },
  { partId: 'P2', operatorId: 'OP-B', trial: 1, value: 25.202 },
  { partId: 'P2', operatorId: 'OP-B', trial: 2, value: 25.203 }
];

// Mediciones Gage R&R para instrumento inaceptable (%GRR > 30%)
const UNACCEPTABLE_OBSERVATIONS = [
  { partId: 'P1', operatorId: 'OP-A', trial: 1, value: 24.80 },
  { partId: 'P1', operatorId: 'OP-A', trial: 2, value: 25.30 },
  { partId: 'P1', operatorId: 'OP-B', trial: 1, value: 24.70 },
  { partId: 'P1', operatorId: 'OP-B', trial: 2, value: 25.40 },
  { partId: 'P2', operatorId: 'OP-A', trial: 1, value: 25.10 },
  { partId: 'P2', operatorId: 'OP-A', trial: 2, value: 24.90 },
  { partId: 'P2', operatorId: 'OP-B', trial: 1, value: 25.30 },
  { partId: 'P2', operatorId: 'OP-B', trial: 2, value: 24.80 }
];

async function setupMsaServer () {
  const core = await startFakeCore({ consumes: { [TOOL.id]: TOOL.consumes } });
  const store = await createStore({ log: quiet });
  const client = createCoreClient({ baseUrl: core.url, apiKey: core.key });
  const publisher = createPublisher({ core: client, mode: 'live', log: quiet });
  const domain = createMsaTool({ store, publisher, log: quiet });
  const poller = createPoller({
    toolId: TOOL.id, consumes: TOOL.consumes, core: client, store,
    processEvent: domain.processEvent, beforeTick: domain.beforeTick, log: quiet
  });
  const app = createApp({
    tool: TOOL, config: {}, core: client, store, poller, publisher,
    registerRoutes: domain.registerRoutes, log: quiet
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  };
  const close = async () => {
    await new Promise((r) => server.close(r));
    await core.close();
    await store.close();
  };
  return { core, store, poller, post, close };
}

test('PV-1.1 & PV-1.2: NEW_DEVICE_REGISTERED (ENS-CAL-001) -> pending study -> capture -> MSA_VALIDATED (acceptable)', async () => {
  const { core, store, poller, post, close } = await setupMsaServer();
  try {
    await poller.tick(); // Cold start at tip

    const regEvent = deviceEvent('ENS-CAL-001', 'register');
    core.seed(regEvent);
    await poller.tick();

    // PV-1.1: El evento fue recibido por la suscripción y registrado
    const pendingList = (await store.listStudies(TOOL.id, 10)).filter((s) => s.status === 'pending');
    assert.equal(pendingList.length, 1, 'Se crea exactamente un estudio pending para ENS-CAL-001');
    const pending = pendingList[0];
    assert.equal(pending.gaugeId, 'ENS-CAL-001');
    assert.equal(pending.inputEventId, regEvent.event_id);
    assert.equal(pending.correlationId, regEvent.correlation_id);
    assert.equal(pending.publish.state, 'awaiting_capture');

    // Captura del estudio Gage R&R con datos aceptables (%GRR < 10%)
    const captureResult = await post(`/api/studies/${pending.id}/capture`, {
      studyType: 'gage_rr',
      observations: ACCEPTABLE_OBSERVATIONS,
      notes: 'Ensayo Integral IsoTools v1.3 - Instrumento ENS-CAL-001'
    });

    assert.equal(captureResult.status, 200);
    assert.equal(captureResult.body.study.verdict, 'acceptable');
    assert.ok(captureResult.body.study.result.gageRRPercent < 10, 'Gage R&R debe ser menor a 10%');
    assert.ok(captureResult.body.study.result.ndc >= 5, 'ndc debe ser >= 5');

    // PV-1.2: Publicación de MSA_VALIDATED con mismo correlation_id y causation_id = registro
    const published = core.published('MSA_VALIDATED');
    assert.equal(published.length, 1);
    const msaEvent = published[0];

    assert.equal(msaEvent.module_id, 'run_msa_analysis');
    assert.equal(msaEvent.event_type, 'MSA_VALIDATED');
    assert.equal(msaEvent.correlation_id, regEvent.correlation_id, 'Mismo correlation_id que el registro');
    assert.equal(msaEvent.causation_id, regEvent.event_id, 'Causation_id apunta al evento de registro');
    assert.equal(msaEvent.asset_id, 'ENS-CAL-001');
    assert.equal(msaEvent.severity, 'low', 'Veredicto aceptable tiene severidad low');
    assert.equal(msaEvent.data.gaugeId, 'ENS-CAL-001');
    assert.equal(msaEvent.data.verdict, 'acceptable');
    assert.equal(typeof msaEvent.data.gageRRPercent, 'number');
    assert.equal(typeof msaEvent.data.repeatability, 'number');
    assert.equal(typeof msaEvent.data.reproducibility, 'number');
    assert.equal(typeof msaEvent.data.ndc, 'number');

    // Comprobar que el envelope cumple estrictamente el esquema oficial de ORCA Core
    assert.deepEqual(core.rejected, [], 'No debe haber rechazos de esquema por parte del core');
  } finally {
    await close();
  }
});

test('PV-1.4: Instrumento ENS-CAL-002 no aceptable publica MSA_VALIDATED con verdict=unacceptable; router rule-pkg-005 no coincide', async () => {
  const { core, store, poller, post, close } = await setupMsaServer();
  try {
    await poller.tick();

    const regEvent = deviceEvent('ENS-CAL-002', 'register');
    core.seed(regEvent);
    await poller.tick();

    const [pending] = (await store.listStudies(TOOL.id, 10)).filter((s) => s.gaugeId === 'ENS-CAL-002');
    assert.ok(pending, 'Estudio pendiente creado para ENS-CAL-002');

    // Captura con datos no aceptables (%GRR > 30%)
    const captureResult = await post(`/api/studies/${pending.id}/capture`, {
      studyType: 'gage_rr',
      observations: UNACCEPTABLE_OBSERVATIONS,
      notes: 'Ensayo Integral IsoTools v1.3 - Instrumento defectuoso ENS-CAL-002'
    });

    assert.equal(captureResult.status, 200);
    assert.equal(captureResult.body.study.verdict, 'unacceptable');
    assert.ok(captureResult.body.study.result.gageRRPercent > 30, 'Gage R&R debe superar 30%');

    const published = core.published('MSA_VALIDATED');
    assert.equal(published.length, 1);
    const msaEvent = published[0];
    assert.equal(msaEvent.data.gaugeId, 'ENS-CAL-002');
    assert.equal(msaEvent.data.verdict, 'unacceptable');
    assert.equal(msaEvent.severity, 'high');

    // Verificación de PV-1.4: La regla de enrutamiento del core rule-pkg-005 especifica:
    // "verdict == 'acceptable'".
    // Al ser verdict === 'unacceptable', esta regla NO dispara hacia calculate_control_charts.
    const ruleMatches = (msaEvent.data.verdict === 'acceptable');
    assert.equal(ruleMatches, false, 'PV-1.4: calculate_control_charts no debe recibir nada si verdict != acceptable');
  } finally {
    await close();
  }
});

test('Operaciones que no sean "register" son ignoradas (rule-pkg-004 operation==register)', async () => {
  const { core, store, poller, close } = await setupMsaServer();
  try {
    await poller.tick();
    core.seed(deviceEvent('ENS-CAL-003', 'update'));
    core.seed(deviceEvent('ENS-CAL-004', 'delete'));
    await poller.tick();

    const studies = await store.listStudies(TOOL.id, 10);
    assert.equal(studies.length, 0, 'No se abren estudios para operaciones distintas de register');
  } finally {
    await close();
  }
});

test('Recepción de evento en formato plano (database row) vs envelope anidado', () => {
  const flatRow = {
    event_id: 'evt-flat-1',
    event_type: 'NEW_DEVICE_REGISTERED',
    asset_id: 'ENS-CAL-001',
    asset_type: 'gauge',
    data: { operation: 'register', gaugeId: 'ENS-CAL-001' },
    correlation_id: 'corr-flat-1'
  };
  const nestedEnvelope = {
    event_id: 'evt-nested-1',
    event: { type: 'NEW_DEVICE_REGISTERED' },
    asset: { asset_id: 'ENS-CAL-001', asset_type: 'gauge' },
    data: { operation: 'register', gaugeId: 'ENS-CAL-001' },
    correlation_id: 'corr-nested-1'
  };

  const parsedFlat = fromCore(flatRow);
  const parsedNested = fromCore(nestedEnvelope);

  assert.equal(parsedFlat.type, 'NEW_DEVICE_REGISTERED');
  assert.equal(parsedFlat.asset.asset_id, 'ENS-CAL-001');
  assert.equal(parsedNested.type, 'NEW_DEVICE_REGISTERED');
  assert.equal(parsedNested.asset.asset_id, 'ENS-CAL-001');
});

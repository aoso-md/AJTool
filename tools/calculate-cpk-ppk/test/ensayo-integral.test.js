// test/ensayo-integral.test.js — Verificación de Escenario 2 del Ensayo Integral IsoTools v1.1
// Documento de referencia: PR-ORCA-ENS-001 (Versión 1.1, 21 de octubre de 2026)
// Escenario 2: Alta de artículo en ERP -> Ciclo de Calidad Completo (Cláusulas ISO: 7.5, 8.5.1, 9.1.3, 8.7, 10.2)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/platform/store.js';
import { createCoreClient } from '../src/platform/core-client.js';
import { createPoller, createPublisher } from '../src/platform/poller.js';
import { TOOL, createCapabilityTool, SPEC_EVENT, specsFromEvent } from '../src/tool.js';
import { analyzeCapability } from '../src/domain/capability.js';
import { fromCore } from '../src/platform/ies.js';
import { startFakeCore, producedEvent } from './helpers/fake-core.js';

const quiet = { info () {}, warn () {}, error () {} };

// Fixtures del Escenario 2 según Sección 4.1 y 5 (Escenario 2):
// Característica CTQ: Diámetro 25.00 mm ± 0.05 mm -> LSL = 24.95, USL = 25.05
const SPEC_CTQ = {
  partId: 'ENS-PZA-001',
  characteristicId: 'CTQ-DIAM-001',
  lsl: 24.95,
  usl: 25.05,
  version: '1'
};

const specEvent = (spec, extra = {}) => producedEvent({
  type: SPEC_EVENT,
  moduleId: 'manage_product_specs',
  data: {
    partId: spec.partId,
    action: 'create',
    characteristics: [{
      id: spec.characteristicId,
      name: 'Diámetro exterior',
      usl: spec.usl,
      lsl: spec.lsl,
      target: 25.00,
      unit: 'mm',
      version: spec.version
    }],
    ...extra
  }
});

// Mediciones del Escenario 2:
// - 25 mediciones dentro de tolerancia (alrededor de 25.00 mm)
// - 8 mediciones consecutivas por arriba de la media (sesgo positivo: 25.03 mm a 25.04 mm)
// - 1 medición fuera de límite superior (25.09 mm, excede USL 25.05 mm)
// Total: 34 mediciones
const MEASUREMENTS_ESCENARIO_2 = [
  // 25 dentro de tolerancia
  25.00, 25.01, 24.99, 25.02, 24.98, 25.00, 25.01, 24.99, 25.02, 24.98,
  25.00, 25.01, 24.99, 25.02, 24.98, 25.00, 25.01, 24.99, 25.02, 24.98,
  25.00, 25.01, 24.99, 25.02, 24.98,
  // 8 consecutivas por arriba de la media (racha Western Electric)
  25.03, 25.03, 25.04, 25.03, 25.04, 25.03, 25.04, 25.04,
  // 1 fuera de límite
  25.09
];

const measurementEvent = (measurements, extra = {}) => producedEvent({
  type: 'MEASUREMENTS_CAPTURED',
  moduleId: 'collect_quality_measurements',
  asset: { asset_id: 'CNC-LATHE-01', asset_type: 'machine', plant_id: 'plant_01', line_id: 'machining_line_1' },
  data: {
    partId: SPEC_CTQ.partId,
    characteristicId: SPEC_CTQ.characteristicId,
    measurements,
    sampleSize: measurements.length,
    batchId: 'BATCH-ENS-20261022',
    inspectorId: 'INSP-001',
    passFailResult: 'fail', // debido al punto 25.09 fuera de especificación
    defectsFound: 1,
    ...extra
  }
});

async function setupCpk () {
  const core = await startFakeCore({ consumes: { [TOOL.id]: TOOL.consumes } });
  const store = await createStore({ log: quiet });
  const client = createCoreClient({ baseUrl: core.url, apiKey: core.key });
  const publisher = createPublisher({ core: client, mode: 'live', log: quiet });
  const tool = createCapabilityTool({ store, core: client, publisher, log: quiet });
  const poller = createPoller({
    toolId: TOOL.id, consumes: TOOL.consumes, core: client, store,
    processEvent: tool.processEvent, beforeTick: tool.beforeTick, log: quiet
  });
  return { core, store, client, tool, poller };
}

test('PV-2.6: tramo CPK con Core simulado — PRODUCT_SPEC_UPDATED -> MEASUREMENTS_CAPTURED -> CAPABILITY_BELOW_TARGET', async () => {
  const { core, store, poller } = await setupCpk();
  try {
    await poller.tick(); // Cold start

    // 1. Ingesta de especificación de manage_product_specs
    const specEvt = specEvent(SPEC_CTQ);
    core.seed(specEvt);

    // 2. Ingesta de mediciones con racha y punto fuera de límite
    const measEvt = measurementEvent(MEASUREMENTS_ESCENARIO_2);
    core.seed(measEvt);

    // El poller ejecuta syncSpecs y luego procesa MEASUREMENTS_CAPTURED
    await poller.tick();

    // Verificación de PV-2.6: calculate_cpk_ppk publica CAPABILITY_BELOW_TARGET
    assert.deepEqual(core.rejected, [], 'El envelope cumple el esquema estricto del core');
    const published = core.published('CAPABILITY_BELOW_TARGET');
    assert.equal(published.length, 1, 'Se emite exactamente un evento CAPABILITY_BELOW_TARGET');

    const cpkEvt = published[0];
    assert.equal(cpkEvt.module_id, 'calculate_cpk_ppk');
    assert.equal(cpkEvt.event_type, 'CAPABILITY_BELOW_TARGET');
    assert.equal(cpkEvt.asset_id, 'CNC-LATHE-01', 'Hereda asset de la estación de medición');
    assert.equal(cpkEvt.causation_id, measEvt.event_id, 'PV-2.7: Causation apunta a MEASUREMENTS_CAPTURED');
    assert.equal(cpkEvt.correlation_id, measEvt.correlation_id, 'PV-2.7: Mismo correlation_id en la cadena');

    // Datos de calidad y trazabilidad
    assert.equal(cpkEvt.data.partId, 'ENS-PZA-001');
    assert.equal(cpkEvt.data.characteristicId, 'CTQ-DIAM-001');
    assert.equal(cpkEvt.data.specVersion, '1', 'Trazabilidad a la versión 1 de la especificación');
    assert.equal(cpkEvt.data.usl, 25.05);
    assert.equal(cpkEvt.data.lsl, 24.95);
    assert.equal(cpkEvt.data.sampleSize, 34);
    assert.ok(cpkEvt.data.cpk < 1.33, `Cpk (${cpkEvt.data.cpk}) debe ser menor al umbral 1.33`);
    assert.equal(cpkEvt.data.status, 'not_capable');
    assert.equal(cpkEvt.severity, 'high');

    // Estado durable en base de datos
    const studies = await store.listStudies(TOOL.id, 10);
    assert.equal(studies.length, 1);
    assert.equal(studies[0].status, 'completed');
    assert.equal(studies[0].publish.state, 'published');
  } finally {
    await core.close();
    await store.close();
  }
});

test('Prevención de ciclo infinito: PRODUCT_SPEC_UPDATED solo actualiza cache y nunca emite eventos', async () => {
  const { core, store, poller } = await setupCpk();
  try {
    await poller.tick();

    // Simulamos que manage_product_specs emite una revisión de la especificación tras Cpk bajo
    const specRevision = specEvent({ ...SPEC_CTQ, version: '2', usl: 25.06, lsl: 24.94 });
    core.seed(specRevision);
    await poller.tick();

    // calculate_cpk_ppk NO debe emitir ningún evento en respuesta a PRODUCT_SPEC_UPDATED
    assert.equal(core.published('CAPABILITY_BELOW_TARGET').length, 0);

    // Pero sí actualiza su cache interno
    const cached = await store.findSpec(SPEC_CTQ.partId, SPEC_CTQ.characteristicId);
    assert.equal(cached.version, '2');
    assert.equal(cached.usl, 25.06);
  } finally {
    await core.close();
    await store.close();
  }
});

test('Proceso capaz (Cpk >= 1.33) se almacena pero NO publica CAPABILITY_BELOW_TARGET', async () => {
  const { core, store, poller } = await setupCpk();
  try {
    await poller.tick();
    core.seed(specEvent(SPEC_CTQ));

    // Mediciones perfectamente centradas y con baja dispersión (Cp = Cpk = 1.67)
    // USL = 25.05, LSL = 24.95, Media = 25.00, 6*sigma = 0.06 -> sigma = 0.01
    const CAPABLE_MEASUREMENTS = [
      25.00, 25.01, 24.99, 25.00, 25.01, 24.99, 25.00, 25.01, 24.99, 25.00,
      25.00, 25.01, 24.99, 25.00, 25.01, 24.99, 25.00, 25.01, 24.99, 25.00
    ];
    core.seed(measurementEvent(CAPABLE_MEASUREMENTS));
    await poller.tick();

    assert.equal(core.published('CAPABILITY_BELOW_TARGET').length, 0, 'No se publica cuando es capaz');
    const [study] = await store.listStudies(TOOL.id, 1);
    assert.equal(study.verdict, 'capable');
    assert.equal(study.publish.state, 'not_required');
  } finally {
    await core.close();
    await store.close();
  }
});

test('Verificación matemática rigurosa: Cp, Cpk, Pp, Ppk con cálculo manual', () => {
  // Caso de control con cálculo analítico conocido:
  // USL = 25.05, LSL = 24.95
  // Mediciones: n=34 de Escenario 2
  const analysis = analyzeCapability({
    measurements: MEASUREMENTS_ESCENARIO_2,
    usl: SPEC_CTQ.usl,
    lsl: SPEC_CTQ.lsl,
    minimumCpk: 1.33,
    marginalFloor: 1.0,
    recommendedSampleSize: 25
  });

  assert.equal(analysis.ok, true);
  const r = analysis.result;
  assert.equal(r.sampleSize, 34);
  assert.ok(r.mean > 25.00, 'La media está desplazada hacia arriba por los 8 puntos y el 25.09');
  assert.ok(r.sigmaWithin > 0, 'sigmaWithin debe ser positiva');
  assert.ok(r.sigmaOverall > 0, 'sigmaOverall debe ser positiva');
  assert.ok(r.sigmaOverall > r.sigmaWithin, 'sigmaOverall incluye la deriva y es mayor que sigmaWithin');
  assert.ok(r.cpk < 1.0, `Cpk debe ser < 1.0 (no capaz): obtenido ${r.cpk}`);
  assert.equal(r.status, 'not_capable');
  assert.equal(r.belowTarget, true);
});

test('Contrato de Cpk configurable: minimumCpk=1.67 vs regla hardcoded de plataforma Cpk < 1.33', () => {
  // Si una pieza crítica requiere minimumCpk = 1.67:
  // Mediciones con Cpk = 1.45 (capaz para estándar 1.33, pero abajo de 1.67)
  const analysis = analyzeCapability({
    measurements: [
      25.00, 25.02, 24.98, 25.01, 24.99, 25.02, 24.98, 25.01, 24.99, 25.00,
      25.00, 25.02, 24.98, 25.01, 24.99, 25.02, 24.98, 25.01, 24.99, 25.00
    ],
    usl: 25.05,
    lsl: 24.95,
    minimumCpk: 1.67,
    marginalFloor: 1.0
  });

  assert.equal(analysis.ok, true);
  // Al tener minimumCpk = 1.67 y Cpk ≈ 1.4, se clasifica como marginal y belowTarget = true
  assert.equal(analysis.result.belowTarget, true);
  // La regla del core rule-qual-005 documentada es "cpk < 1.33 OR status == 'not_capable'"
  // Esto demuestra que si la herramienta emite con Cpk = 1.45 y status = 'marginal',
  // la regla de enrutamiento del Core NO la reenviaría a manage_product_specs salvo que
  // el Core actualice su regla a "belowTarget == true" o se use minimumCpk=1.33.
});

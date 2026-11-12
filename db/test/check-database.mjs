// The same fail-fast gate used by server.js, suitable for a CI preflight.
import { createStore } from '../../tools/calculate-cpk-ppk/src/platform/store.js';

try {
  const store = await createStore({ databaseUrl: process.env.DATABASE_URL,
    databaseRequired: true, failFast: true, log: { info () {}, error () {} } });
  await store.close();
  console.log('STARTUP_DATABASE_VALIDATED');
} catch (error) {
  console.error(error.code === 'startup_configuration_failure' ? error.message : 'STARTUP_CONFIGURATION_FAILURE [unexpected_error]');
  process.exitCode = 1;
}

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const dockerfiles = new Map([
  ['calculate-cpk-ppk', 'docker/calculate_cpk_ppk.Dockerfile'],
  ['run-msa-analysis', 'docker/run_msa_analysis.Dockerfile']
]);

export function configurationErrors(variables, service, revision) {
  if (!dockerfiles.has(service) || !/^[a-f0-9]{40}$/.test(revision || '')) return ['invalid_release_target'];
  const expected = {
    DATABASE_REQUIRED: 'true',
    NODE_EXTRA_CA_CERTS: '/app/certs/supabase-prod-ca-2021.crt',
    NODE_ENV: 'production',
    AJTOOL_ENVIRONMENT: 'production',
    CORE_PUBLISH: 'shadow',
    POLL_ENABLED: 'false',
    RAILWAY_DOCKERFILE_PATH: dockerfiles.get(service),
    AJTOOL_RELEASE_REVISION: revision
  };
  const errors = Object.entries(expected)
    .filter(([name, value]) => variables?.[name] !== value)
    .map(([name]) => name);
  for (const name of ['ISOTOOLS_API_URL', 'ISOTOOLS_API_KEY']) {
    if (typeof variables?.[name] !== 'string' || !variables[name].trim()) errors.push(name);
  }
  try {
    const url = new URL(variables.DATABASE_URL);
    const project = 'lcteryhtsynrxgfpvryt';
    const user = decodeURIComponent(url.username);
    const direct = url.hostname === `db.${project}.supabase.co` && user === 'ajtool_service';
    const session = url.hostname === 'aws-1-us-west-2.pooler.supabase.com' && user === `ajtool_service.${project}`;
    const overrides = [...url.searchParams.keys()].some(name => /^(host|hostname|hostaddr|port|user|username|database|dbname|password|service|servicefile|options)$/i.test(name));
    if ((!direct && !session) || !['postgres:', 'postgresql:'].includes(url.protocol)
      || (session ? url.port !== '5432' : url.port && url.port !== '5432')
      || url.pathname !== '/postgres' || !url.password || overrides) errors.push('DATABASE_URL');
  } catch {
    errors.push('DATABASE_URL');
  }
  return errors;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const errors = configurationErrors(JSON.parse(readFileSync(0, 'utf8')), process.argv[2], process.argv[3]);
    console.log(JSON.stringify({ accepted: errors.length === 0, missingOrInvalid: errors }));
    if (errors.length) process.exitCode = 1;
  } catch {
    console.error('Railway variable metadata could not be verified.');
    process.exitCode = 1;
  }
}

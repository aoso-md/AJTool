import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readinessErrors,validateTarget} from '../review/check-deployment-ready.mjs';
import { configurationErrors } from '../../deploy/official/check-railway-cutover.mjs';
const good={status:'ready',tool:'calculate_cpk_ppk',auth:'open',persistence:{tier:'postgres',durable:true}};
test('accepts only the matching official domain and tool',()=>{
  validateTarget('https://ccp.orcalabs.mx/ready','calculate_cpk_ppk');
  validateTarget('https://rma.orcalabs.mx/ready','run_msa_analysis');
  for(const url of ['https://calculate-cpk-ppk-production.up.railway.app/ready','http://ccp.orcalabs.mx/ready','https://ccp.orcalabs.mx/ready?token=synthetic'])assert.throws(()=>validateTarget(url,'calculate_cpk_ppk'));
  assert.throws(()=>validateTarget('https://rma.orcalabs.mx/ready','calculate_cpk_ppk'));
});
test('200 ready alone does not accept volatile memory',()=>{
  assert.deepEqual(readinessErrors({...good,persistence:{tier:'memory',durable:false}},good.tool),['expected_postgres','storage_not_durable']);
});
test('durability must be explicit, including when postgres is named',()=>{
  assert.ok(readinessErrors({...good,persistence:{tier:'postgres'}},good.tool).includes('storage_not_durable'));
});
test('rejects a healthy response from the other tool',()=>{
  assert.ok(readinessErrors({...good,tool:'run_msa_analysis'},good.tool).includes('wrong_tool'));
});
test('enforces Carlos open authentication contract',()=>{
  assert.ok(readinessErrors({...good,auth:'sso'},good.tool).includes('expected_open_authentication'));
});
test('rejects unavailable and malformed responses',()=>{
  assert.ok(readinessErrors({...good,status:'not_ready'},good.tool).includes('service_not_ready'));
  assert.ok(readinessErrors(null,good.tool).length>0);
});
test('accepts durable postgres in the agreed open mode',()=>{
  assert.deepEqual(readinessErrors(good,good.tool),[]);
});

test('cutover requires durable shadow with polling disabled',()=>{
  const cutover={...good,publish:'shadow',poller:{enabled:false}};
  assert.deepEqual(readinessErrors(cutover,good.tool,{cutover:true}),[]);
  assert.deepEqual(readinessErrors({...cutover,publish:'live',poller:{enabled:true}},good.tool,{cutover:true}),
    ['expected_shadow','expected_polling_disabled']);
});
test('Railway preflight verifies the approved SHA and the dedicated runtime without returning values',()=>{
  const revision='a'.repeat(40);
  const vars={DATABASE_REQUIRED:'true',NODE_EXTRA_CA_CERTS:'/app/certs/supabase-prod-ca-2021.crt',NODE_ENV:'production',
    AJTOOL_ENVIRONMENT:'production',CORE_PUBLISH:'shadow',POLL_ENABLED:'false',
    RAILWAY_DOCKERFILE_PATH:'docker/calculate_cpk_ppk.Dockerfile',AJTOOL_RELEASE_REVISION:revision,
    ISOTOOLS_API_URL:'https://example.invalid',ISOTOOLS_API_KEY:'synthetic-test-only',
    DATABASE_URL:'postgresql://ajtool_service.lcteryhtsynrxgfpvryt:synthetic-test-only@aws-1-us-west-2.pooler.supabase.com:5432/postgres'};
  assert.deepEqual(configurationErrors(vars,'calculate-cpk-ppk',revision),[]);
  assert.deepEqual(configurationErrors({...vars,POLL_ENABLED:'true',DATABASE_URL:vars.DATABASE_URL.replace('ajtool_service','postgres')},'calculate-cpk-ppk',revision),
    ['POLL_ENABLED','DATABASE_URL']);
});

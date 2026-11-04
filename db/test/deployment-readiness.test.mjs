import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readinessErrors,validateTarget} from '../review/check-deployment-ready.mjs';
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

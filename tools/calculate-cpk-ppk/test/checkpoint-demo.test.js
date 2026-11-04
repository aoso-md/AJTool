import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analyzeCapability} from '../src/domain/capability.js';
const read=name=>JSON.parse(readFileSync(new URL(`../../../db/test/fixtures/checkpoint-demo/${name}.json`,import.meta.url),'utf8'));
test('25 individual subgroups reproduce independently calculated Cp/Cpk/Pp/Ppk',()=>{
  const input=read('cpk-payload');assert.equal(input.measurements.length,25);
  const actual=analyzeCapability(input);assert.equal(actual.ok,true);
  for(const [key,value] of Object.entries(read('expected').cpk))assert.ok(Math.abs(actual.result[key]-value)<(key.startsWith('sigma')?0.00000051:0.000051),key);
  assert.equal(analyzeCapability({...input,lsl:input.usl}).ok,false);
  assert.equal(analyzeCapability({...input,measurements:[10]}).ok,false);
});

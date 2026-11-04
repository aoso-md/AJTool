import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analyzeGageRR} from '../src/domain/gage-rr.js';
const read=name=>JSON.parse(readFileSync(new URL(`../../../db/test/fixtures/checkpoint-demo/${name}.json`,import.meta.url),'utf8'));
test('3 operators x 10 parts x 3 trials reproduce independent Average & Range reference',()=>{
  const {observations}=read('msa-payload');assert.equal(observations.length,90);
  const actual=analyzeGageRR(observations);assert.equal(actual.ok,true);
  for(const [key,value] of Object.entries(read('expected').msa)) {
    if(key==='ndc')assert.equal(actual.result[key],value);
    else assert.ok(Math.abs(actual.result[key]-value)<(key==='gageRRPercent'?0.0051:0.00000051),key);
  }
  assert.equal(actual.result.verdict,'acceptable');
});

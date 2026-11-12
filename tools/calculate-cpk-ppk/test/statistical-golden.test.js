import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analyzeCapability} from '../src/domain/capability.js';
const golden=JSON.parse(readFileSync(new URL('../../../db/test/fixtures/statistical-golden.json',import.meta.url),'utf8'));
for(const item of golden.cpk) test(`independent Decimal reference: ${item.name}`,()=>{
 const result=analyzeCapability(item.input);assert.equal(result.ok,true,JSON.stringify(result));
 for(const [key,expected] of Object.entries(item.expected)) {
   const tolerance=key==='ndc'?0:['gageRRPercent','contributionPercent'].includes(key)?.0051:['cp','cpk','pp','ppk'].includes(key)?.000051:.00000051;
   assert.ok(Math.abs(result.result[key]-expected)<=tolerance,`${key}: ${result.result[key]} versus independent ${expected}`);
 }
});

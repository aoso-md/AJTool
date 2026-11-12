import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeGageRR} from '../src/domain/gage-rr.js';
const data=Array.from({length:2},(_,p)=>['A','B'].flatMap((operatorId,o)=>[1,2].map(trial=>({partId:`P${p}`,operatorId,trial,value:10+p*.2+o*.002+trial*.001})))).flat();
test('labels containing delimiters cannot change a valid crossed study',()=>{
 const renamed=data.map(o=>({...o,partId:o.partId==='P0'?'P|Q':'Q',operatorId:o.operatorId==='A'?'A':'A|P'}));
 const original=analyzeGageRR(data);const result=analyzeGageRR(renamed);assert.equal(result.ok,true);assert.deepEqual(result.result,original.result);
});
test('overflow in finite measurement ranges must not return nonfinite MSA',()=>{
 const result=analyzeGageRR(data.map((o,i)=>({...o,value:i%2?1e308:-1e308})));assert.equal(result.ok,false);
});

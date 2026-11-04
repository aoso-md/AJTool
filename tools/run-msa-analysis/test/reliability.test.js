import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sequenceValue,compareSequence,inboxEvent,retryTransaction} from '../src/platform/reliability.js';
import {fromCore} from '../src/platform/ies.js';
test('exact sequence transport and bounds',()=>{
  assert.equal(sequenceValue('9007199254740993'),'9007199254740993');
  assert.equal(compareSequence('9007199254740993','9007199254740992'),1);
  for(const value of [Number.MAX_SAFE_INTEGER+1,-1,1.5,'9223372036854775808','1e4']) assert.throws(()=>sequenceValue(value));
  assert.equal(fromCore({seq:'9007199254740993'}).seq,'9007199254740993');
});
test('flat and nested events share canonical content; transport sequence is excluded',()=>{
  const nested={event_id:'id',seq:'9007199254740993',timestamp:'2026-10-23T00:00:00Z',platform_version:'1.0',module:{id:'source',version:'1'},asset:{asset_id:'part'},event:{type:'TYPE',category:'quality',severity:'low'},data:{b:2,a:1},metadata:{shift:'A'}};
  const flat={event_id:'id',seq:'9007199254740994',timestamp:nested.timestamp,platform_version:'1.0',module_id:'source',module_version:'1',asset_id:'part',event_type:'TYPE',category:'quality',severity:'low',data:{a:1,b:2},metadata:{shift:'A'}};
  assert.equal(inboxEvent(fromCore(nested)).inputHash,inboxEvent(fromCore(flat)).inputHash);
  flat.data.a=9;assert.notEqual(inboxEvent(fromCore(nested)).inputHash,inboxEvent(fromCore(flat)).inputHash);
  assert.throws(()=>inboxEvent(fromCore({seq:1})),/identity/);
});
test('transaction retries are bounded and exclude connection/unknown errors',async()=>{
  let calls=0;assert.equal(await retryTransaction(async()=>{if(++calls<3)throw Object.assign(new Error('serialization'),{code:'40001'});return 'ok';}),'ok');assert.equal(calls,3);
  calls=0;await assert.rejects(retryTransaction(async()=>{calls++;throw Object.assign(new Error('deadlock'),{code:'40P01'});}));assert.equal(calls,3);
  calls=0;await assert.rejects(retryTransaction(async()=>{calls++;throw Object.assign(new Error('unknown commit'),{code:'ECONNRESET'});}));assert.equal(calls,1);
});

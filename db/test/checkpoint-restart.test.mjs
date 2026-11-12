import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepare,fixture} from './helpers/isolated-postgres.mjs';
import {runStartup} from './helpers/startup-process.mjs';

for(const service of ['calculate-cpk-ppk','run-msa-analysis']) test(`${service}: actual process restart preserves full study and shadow outbox`,async()=>{
  const f=await fixture(service,prepare());
  const tag=service==='calculate-cpk-ppk'?'cpk':'msa';
  const payload=JSON.parse(readFileSync(new URL(`./fixtures/checkpoint-demo/${tag}-payload.json`,import.meta.url),'utf8'));
  let saved, rows;
  const headers={'x-api-key':'startup-local-test-only','content-type':'application/json'};
  try {
    const first=await runStartup(service,f.url,{healthy:true,exercise:async({base})=>{
      const created=await fetch(base+'/api/studies',{method:'POST',headers,body:JSON.stringify(payload)});
      assert.equal(created.status,201);const {study}=await created.json();
      const published=await fetch(`${base}/api/studies/${study.id}/publish`,{method:'POST',headers,body:'{}'});
      assert.equal(published.status,200);
      const read=await fetch(`${base}/api/studies/${study.id}`,{headers});assert.equal(read.status,200);saved=(await read.json()).study;
      assert.ok(saved.result);assert.equal(saved.status,'completed');
      rows=(await f.pool.query('SELECT * FROM public.event_outbox WHERE study_id=$1',[study.id])).rows;
      assert.equal(rows.length,1);assert.equal(rows[0].mode,'shadow');assert.equal(rows[0].state,'shadow_recorded');
    }});
    assert.equal(first.code,0);
    const second=await runStartup(service,f.url,{healthy:true,exercise:async({base})=>{
      const read=await fetch(`${base}/api/studies/${saved.id}`,{headers});assert.equal(read.status,200);
      assert.deepEqual((await read.json()).study,saved);
      assert.deepEqual((await f.pool.query('SELECT * FROM public.event_outbox WHERE study_id=$1',[saved.id])).rows,rows);
    }});
    assert.equal(second.code,0);
  } finally {await f.close();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepare,fixture,root} from './helpers/isolated-postgres.mjs';
import {runStartup} from './helpers/startup-process.mjs';

for(const [tag,service,callback] of [
  ['cpk','calculate-cpk-ppk','https://ccp.orcalabs.mx/auth/callback'],
  ['msa','run-msa-analysis','https://rma.orcalabs.mx/auth/callback']
]) test(`${service}: Carlos open contract, PostgreSQL, UI and recovery without credentials`,async()=>{
  const example=readFileSync(new URL(`../../deploy/carlos/${tag}.env.example`,import.meta.url),'utf8');
  const settings=Object.fromEntries(example.split(/\r?\n/).filter(l=>l&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)];}));
  assert.equal(settings.OIDC_ISSUER,'');assert.equal(settings.TOOL_API_KEY,'');
  assert.equal(settings.OIDC_REDIRECT_URI,callback);assert.equal(settings.DATABASE_REQUIRED,'true');
  const f=await fixture(service,prepare());
  const payload=JSON.parse(readFileSync(new URL(`./fixtures/checkpoint-demo/${tag}-payload.json`,import.meta.url),'utf8'));
  const expected=JSON.parse(readFileSync(new URL('./fixtures/checkpoint-demo/expected.json',import.meta.url),'utf8'))[tag];
  const environment={...settings,DATABASE_URL:f.url,UI_DIST_DIR:`${root}tools/${service}/web/dist`};
  let saved,outbox;
  const headers={'content-type':'application/json'}; // Deliberately no cookie or API key.
  try {
    const first=await runStartup(service,f.url,{healthy:true,environment,exercise:async({base})=>{
      let r=await fetch(base+'/auth/me');assert.equal(r.status,200);const session=await r.json();assert.equal(session.mode,'open');assert.equal(session.authenticated,false);
      r=await fetch(base+'/ready');const ready=await r.json();assert.equal(ready.auth,'open');assert.equal(ready.persistence.tier,'postgres');assert.equal(ready.publish,'shadow');assert.equal(ready.poller.enabled,false);
      r=await fetch(base+'/');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/html/);assert.match(await r.text(),/<div id="root"><\/div>/);
      r=await fetch(base+'/api/status');assert.equal(r.status,200);assert.equal((await r.json()).core.configured,false);
      r=await fetch(base+'/api/studies',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(r.status,201);saved=(await r.json()).study;
      for(const [key,value]of Object.entries(expected)){
        const tolerance=tag==='cpk'?(key.startsWith('sigma')?0.00000051:0.000051):(key==='gageRRPercent'?0.0051:0.00000051);
        if(key==='ndc')assert.equal(saved.result[key],value);else assert.ok(Math.abs(saved.result[key]-value)<tolerance,key);
      }
      r=await fetch(`${base}/api/studies/${saved.id}/publish`,{method:'POST',headers,body:'{}'});assert.equal(r.status,200);
      r=await fetch(`${base}/api/studies/${saved.id}`);saved=(await r.json()).study;
      outbox=(await f.pool.query('SELECT * FROM event_outbox WHERE study_id=$1',[saved.id])).rows;
      assert.equal(outbox.length,1);assert.equal(outbox[0].mode,'shadow');assert.equal(outbox[0].state,'shadow_recorded');
    }});assert.equal(first.code,0);
    const second=await runStartup(service,f.url,{healthy:true,environment,exercise:async({base})=>{
      const r=await fetch(`${base}/api/studies/${saved.id}`);assert.equal(r.status,200);assert.deepEqual((await r.json()).study,saved);
      assert.deepEqual((await f.pool.query('SELECT * FROM event_outbox WHERE study_id=$1',[saved.id])).rows,outbox);
    }});assert.equal(second.code,0);
  }finally{await f.close();}
});

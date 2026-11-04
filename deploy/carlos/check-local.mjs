// Calls only the two fixed localhost demo ports. Saves synthetic studies only.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
const folder=root+'artifacts/entrega-carlos-20261027';mkdirSync(folder,{recursive:true});
const mode=process.argv[2]||'create';assert.ok(['create','recover'].includes(mode));
const evidence=[];
for(const [tag,port]of [['cpk',29108],['msa',29109]]){
  const base=`http://127.0.0.1:${port}`;
  let ready;const deadline=Date.now()+60000;
  while(Date.now()<deadline){try{const r=await fetch(base+'/ready',{signal:AbortSignal.timeout(1000)});if(r.ok){ready=await r.json();break;}}catch{}await new Promise(r=>setTimeout(r,200));}
  assert.ok(ready);assert.equal(ready.auth,'open');assert.equal(ready.persistence.tier,'postgres');assert.equal(ready.publish,'shadow');assert.equal(ready.poller.enabled,false);
  let r=await fetch(base+'/auth/me');const auth=await r.json();assert.equal(auth.mode,'open');assert.equal(auth.authenticated,false);
  r=await fetch(base+'/');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/html/);
  r=await fetch(base+'/api/status');assert.equal((await r.json()).core.configured,false);
  const path=`${folder}/${tag}-open-study.json`;let saved;
  if(mode==='create'){
    const payload=readFileSync(`${root}db/test/fixtures/checkpoint-demo/${tag}-payload.json`,'utf8');
    r=await fetch(base+'/api/studies',{method:'POST',headers:{'content-type':'application/json'},body:payload});assert.equal(r.status,201);saved=(await r.json()).study;
    writeFileSync(path,JSON.stringify(saved,null,2)+'\n');
  }else saved=JSON.parse(readFileSync(path,'utf8'));
  r=await fetch(`${base}/api/studies/${saved.id}`);assert.equal(r.status,200);assert.deepEqual((await r.json()).study,saved);
  evidence.push({tag,auth:'open',persistence:'postgres',coreConfigured:false,publish:'shadow',polling:false,ui:200,credentialsRequired:false,study:saved.id,documentSha256:createHash('sha256').update(JSON.stringify(saved)).digest('hex'),mode,checkedAt:new Date().toISOString()});
}
writeFileSync(`${folder}/open-${mode}.json`,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));

// Real TLS against the runner-owned PostgreSQL only; ephemeral test CA is never deployed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {prepare,fixture,container,docker,sql,root} from './helpers/isolated-postgres.mjs';
import {runStartup} from './helpers/startup-process.mjs';
import {resolveOpenSsl} from './helpers/openssl.mjs';

assert.match(container,/^ajtool-durability-ci-[a-f0-9]+$/);
const temp=mkdtempSync(join(tmpdir(),'ajtool-tls-'));
const openssl=resolveOpenSsl();
function certificate(args){const r=spawnSync(openssl,args,{cwd:temp,encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(r.status,0,'Test certificate generation failed; configure AJTOOL_OPENSSL_BIN');}
function absolute(name){return join(temp,name);}

test('CPK/MSA actual PostgreSQL TLS verifies CA, rejects unknown CA and preserves shadow studies across reopen',async()=>{
 const evidence={scope:'isolated local PostgreSQL TLS only; not Supabase certification',trustedConnectionVerified:false,unknownCaRejected:false,tools:{}};
 try{
  certificate(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-subj','/CN=AJTool ephemeral fixture CA','-days','1']);
  certificate(['req','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-subj','/CN=localhost']);
  writeFileSync(absolute('server.ext'),'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  certificate(['x509','-req','-in','server.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-out','server.crt','-days','1','-extfile','server.ext']);
  const remote='/tmp/ajtool-fixture-tls';
  docker(['exec',container,'mkdir','-p',remote]);
  for(const file of ['server.crt','server.key'])docker(['cp',absolute(file),`${container}:${remote}/${file}`]);
  docker(['exec',container,'chown','postgres:postgres',`${remote}/server.key`,`${remote}/server.crt`]);
  docker(['exec',container,'chmod','600',`${remote}/server.key`]);
  sql('ajtool_test',`ALTER SYSTEM SET ssl_cert_file='${remote}/server.crt'`);
  sql('ajtool_test',`ALTER SYSTEM SET ssl_key_file='${remote}/server.key'`);
  sql('ajtool_test',"ALTER SYSTEM SET ssl='on'");sql('ajtool_test','SELECT pg_reload_conf()');
  const headers={'x-api-key':'startup-local-test-only','content-type':'application/json'};
  for(const service of ['calculate-cpk-ppk','run-msa-analysis']){
   const f=await fixture(service,prepare());
   try{
    const url=new URL(f.url);url.searchParams.set('sslmode','verify-full');url.searchParams.set('application_name','ajtool-tls-proof');
    const common={NODE_ENV:'production',AJTOOL_ENVIRONMENT:'staging',TOOL_API_KEY:'',NODE_EXTRA_CA_CERTS:undefined};
    const rejected=await runStartup(service,url.href,{environment:common});
    assert.notEqual(rejected.code,0);assert.equal(rejected.listening,false,'Untrusted CA must fail before listening');
    let saved,outbox;
    const environment={...common,NODE_EXTRA_CA_CERTS:absolute('ca.crt')};
    for(let pass=0;pass<2;pass++){
     const r=await runStartup(service,url.href,{healthy:true,environment,exercise:async({base})=>{
      const ready=await(await fetch(base+'/ready')).json();assert.equal(ready.auth,'open');assert.equal(ready.persistence.tier,'postgres');assert.equal(ready.persistence.durable,true);
      assert.ok(Number(sql(f.db,`SELECT count(*) FROM pg_stat_ssl s JOIN pg_stat_activity a USING(pid) WHERE a.usename='${f.role}' AND a.application_name='ajtool-tls-proof' AND s.ssl AND s.bits>=128`))>=1);
      assert.equal(sql(f.db,`SELECT count(*) FROM pg_stat_ssl s JOIN pg_stat_activity a USING(pid) WHERE a.usename='${f.role}' AND a.application_name='ajtool-tls-proof' AND NOT s.ssl`),'0');
      if(pass===0){
       const tag=service==='calculate-cpk-ppk'?'cpk':'msa';
       const payload=JSON.parse(readFileSync(new URL(`./fixtures/checkpoint-demo/${tag}-payload.json`,import.meta.url),'utf8'));
       const created=await fetch(base+'/api/studies',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(created.status,201);
       const id=(await created.json()).study.id;
       assert.equal((await fetch(base+'/api/studies/'+id+'/publish',{method:'POST',headers,body:'{}'})).status,200);
       saved=(await(await fetch(base+'/api/studies/'+id,{headers})).json()).study;
       outbox=(await f.pool.query('SELECT * FROM event_outbox WHERE study_id=$1',[id])).rows;
       assert.equal(outbox.length,1);assert.equal(outbox[0].mode,'shadow');assert.equal(outbox[0].state,'shadow_recorded');
      }else{
       assert.deepEqual((await(await fetch(base+'/api/studies/'+saved.id,{headers})).json()).study,saved);
       assert.deepEqual((await f.pool.query('SELECT * FROM event_outbox WHERE study_id=$1',[saved.id])).rows,outbox);
      }
     }});assert.equal(r.code,0);
    }
    evidence.tools[service]={trustedTls:true,unknownCaStartupRejected:true,studyAndShadowOutboxExactAfterReopen:true,liveEventsSent:false};
   }finally{await f.close();}
  }
  evidence.trustedConnectionVerified=true;evidence.unknownCaRejected=true;
  const output=resolve(root,process.env.AJTOOL_TEST_EVIDENCE||'artifacts/local-tls');mkdirSync(output,{recursive:true});writeFileSync(join(output,'tls-proof.json'),JSON.stringify(evidence,null,2));
 }finally{
  // Remove only the exact randomly created temporary folder, after all child processes exit.
  assert.ok(resolve(temp).startsWith(resolve(tmpdir())+sep+'ajtool-tls-'));
  rmSync(temp,{recursive:true,force:true});
 }
});

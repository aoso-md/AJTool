// Own workstation publication only. Never operates official ORCA/Railway processes.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const root=fileURLToPath(new URL('../',import.meta.url)),priv=root+'.env.ajtool-supabase/',out=root+'artifacts/final-execution-20261101/';mkdirSync(out,{recursive:true});
const {Pool}=createRequire(new URL('../tools/calculate-cpk-ppk/package.json',import.meta.url))('pg');
const docker=(args)=>{const r=spawnSync('docker',args,{cwd:root,windowsHide:true,timeout:300000,maxBuffer:12*1024*1024});if(r.status!==0)throw new Error('OWN_DEPLOY_DOCKER_OPERATION_FAILED');return r.stdout.toString().trim();};
const sha=data=>createHash('sha256').update(data).digest('hex');
const report={scope:'workstation loopback services connected to real Supabase AJTool; not an Internet or official ORCA deployment',atUtc:new Date().toISOString(),services:{},postgresUsedForBackend:false,officialInstancesModified:false,liveEventsSent:false};
const readiness=async base=>{const end=Date.now()+45000;while(Date.now()<end){try{const r=await fetch(base+'/ready',{signal:AbortSignal.timeout(2000)});if(r.ok)return await r.json();}catch{}await new Promise(r=>setTimeout(r,300));}throw new Error('OWN_DEPLOY_NOT_READY');};
let pool;
try{
 const runtime=new URL(process.env.AJTOOL_TARGET_DATABASE_URL||'');assert.equal(decodeURIComponent(runtime.username),'ajtool_service.lcteryhtsynrxgfpvryt');assert.equal(runtime.hostname,'aws-1-us-west-2.pooler.supabase.com');
 const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).stdout.trim();assert.match(revision,/^[a-f0-9]{40}$/);report.revision=revision;
 const ca=readFileSync(root+'db/review/certs/supabase-prod-ca-2021.crt');const clean=new URL(runtime);for(const k of [...clean.searchParams.keys()])if(k.startsWith('ssl'))clean.searchParams.delete(k);
 pool=new Pool({connectionString:clean.toString(),ssl:{ca,rejectUnauthorized:true,servername:runtime.hostname},max:1,connectionTimeoutMillis:10000,query_timeout:10000});pool.on('error',()=>{});
 const priorRuntime=(await pool.query('SELECT tool,environment,publish_mode FROM runtime_identity')).rows;
 if(priorRuntime.some(r=>r.environment!=='production'||r.publish_mode!=='shadow'))throw new Error('EXISTING_RUNTIME_IDENTITY_REQUIRES_REVIEW');
 const snapshots={};
 for(const [tag,service,port,published] of [['cpk','calculate-cpk-ppk',8108,30128],['msa','run-msa-analysis',8109,30129]]){
  const name='ajtool-owned-supabase-'+tag+'-20261101',image='ajtool-'+tag+'-release:20261101';
  assert.equal(docker(['image','inspect','--format','{{index .Config.Labels "org.opencontainers.image.revision"}}',image]),revision);
  if(spawnSync('docker',['container','inspect',name],{windowsHide:true}).status===0)throw new Error('OWN_DEPLOY_ALREADY_EXISTS_PRESERVE_STATE');
  const envFile=priv+'owned-'+tag+'.env';if(existsSync(envFile))throw new Error('OWN_ENV_ALREADY_EXISTS_REVIEW_REQUIRED');
  writeFileSync(envFile,`DATABASE_URL=${runtime}\nDATABASE_REQUIRED=true\nNODE_EXTRA_CA_CERTS=/app/certs/supabase-prod-ca-2021.crt\nNODE_ENV=production\nAJTOOL_ENVIRONMENT=production\nCORE_PUBLISH=shadow\nPOLL_ENABLED=false\nOIDC_ISSUER=\nTOOL_API_KEY=\nISOTOOLS_API_URL=\nISOTOOLS_API_KEY=\nPORT=${port}\nOIDC_REDIRECT_URI=https://${tag==='cpk'?'ccp':'rma'}.orcalabs.mx/auth/callback\n`,{flag:'wx',mode:0o600});
  docker(['run','-d','--name',name,'--label','ajtool.owned-supabase=true','--label','ajtool.release-revision='+revision,'--env-file',envFile,'-p',`127.0.0.1:${published}:${port}`,image]);
  const base='http://127.0.0.1:'+published,ready=await readiness(base);assert.equal(ready.persistence.tier,'postgres');assert.equal(ready.persistence.durable,true);assert.equal(ready.publish,'shadow');assert.equal(ready.poller.enabled,false);assert.equal(ready.auth,'open');
  const payload=JSON.parse(readFileSync(root+`db/test/fixtures/checkpoint-demo/${tag}-payload.json`));
  if(tag==='cpk')payload.partId='AJTOOL-RELEASE-ACCEPTANCE-20261101';else payload.gaugeId='AJTOOL-RELEASE-ACCEPTANCE-20261101';
  const headers={'content-type':'application/json'};const r=await fetch(base+'/api/studies',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(r.status,201);let study=(await r.json()).study;
  const expected=JSON.parse(readFileSync(root+'db/test/fixtures/checkpoint-demo/expected.json'))[tag];
  for(const [key,value]of Object.entries(expected)){const tolerance=tag==='cpk'?(key.startsWith('sigma')?0.00000051:0.000051):(key==='gageRRPercent'?0.0051:0.00000051);if(key==='ndc')assert.equal(study.result[key],value);else assert.ok(Math.abs(study.result[key]-value)<tolerance);}
  assert.equal((await fetch(`${base}/api/studies/${study.id}/publish`,{method:'POST',headers,body:'{}'})).status,200);
  study=(await(await fetch(`${base}/api/studies/${study.id}`)).json()).study;snapshots[tag]=study;
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM event_outbox WHERE study_id=$1 AND mode='shadow' AND state='shadow_recorded'",[study.id])).rows[0].n,1);
  const identity=(await pool.query('SELECT current_user')).rows[0].current_user;assert.equal(identity,'ajtool_service');
  docker(['restart',name]);await readiness(base);assert.deepEqual((await(await fetch(`${base}/api/studies/${study.id}`)).json()).study,study);
  const imageId=docker(['image','inspect','--format','{{.Id}}',image]);const runningImage=docker(['inspect','--format','{{.Image}}',name]);assert.equal(imageId,runningImage);
  const certSha=docker(['exec',name,'node','-e',"console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('/app/certs/supabase-prod-ca-2021.crt')).digest('hex'))"]);assert.equal(certSha,sha(ca));
  report.services[tag]={url:base,container:name,image,imageId,revision,role:identity,postgresDurable:true,independentCalculationFixturePassed:true,studyId:study.id,studyDocumentSha256:sha(JSON.stringify(study)),recoveredAfterAppRestart:true,shadowOutbox:true,caInImageVerified:true,auth:'open',networkScope:'127.0.0.1 only'};
 }
 writeFileSync(priv+'owned-synthetic-study-snapshots.json',JSON.stringify(snapshots),{flag:'wx',mode:0o600});
 report.status='OWN_LOOPBACK_SERVICES_REAL_SUPABASE_PASS';writeFileSync(out+'owned-services.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){report.status='OWN_DEPLOY_BLOCKED';report.reason=/^[A-Z_]+$/.test(error.message)?error.message:'OWN_DEPLOY_ASSERTION_FAILED';writeFileSync(out+'owned-services.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));process.exitCode=2;}
finally{await pool?.end().catch(()=>{});}

import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url)),priv=root+'.env.ajtool-supabase/',ev=root+'artifacts/real-postgres-20261101/';
const db='ajtool-real-restore-20261101',network='ajtool-real-staging-20261101';
const run=(args,input)=>{const r=spawnSync('docker',args,{input,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});if(r.status!==0)throw new Error('LOCAL_DOCKER_OPERATION_FAILED');return r.stdout.toString().trim();};
const sql=(text,database='postgres')=>run(['exec','-i',db,'psql','-X','-At','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],Buffer.from(text));
const state={scope:'local applications on isolated actual-restored PostgreSQL; synthetic acceptance studies only',remoteMutations:false,liveEventsSent:false,tools:{}};
async function waitReady(base){const end=Date.now()+30000;while(Date.now()<end){try{const r=await fetch(base+'/ready',{signal:AbortSignal.timeout(1500)});if(r.ok)return await r.json();}catch{}await new Promise(resolve=>setTimeout(resolve,250));}throw new Error('STAGING_NOT_READY');}
const instances=[];
try{
 const localUrl=new URL(process.env.AJTOOL_RESTORED_RUNTIME_DATABASE_URL||'');assert.equal(localUrl.hostname,'127.0.0.1');
 const label=run(['inspect','--format','{{index .Config.Labels "ajtool.real-restore"}}',db]);assert.equal(label,'true');
 const access='ajtool-real-access-20261101';
 for(const [net,internal] of [[network,true],[access,false]]){
  const check=spawnSync('docker',['network','inspect',net],{windowsHide:true});
  if(check.status!==0)run(['network','create',...(internal?['--internal']:[]),'--label','ajtool.real-staging=true',net]);
  else assert.equal(JSON.parse(check.stdout)[0].Labels['ajtool.real-staging'],'true');
 }
 const databaseNetworks=JSON.parse(run(['inspect','--format','{{json .NetworkSettings.Networks}}',db]));
 if(!databaseNetworks[network])run(['network','connect','--alias','db',network,db]);
 for(const [tag,service,port] of [['cpk','calculate-cpk-ppk',8108],['msa','run-msa-analysis',8109]]){
  const database='ajtool_'+tag;
  if(sql(`SELECT count(*) FROM pg_database WHERE datname='${database}'`)!=='1')sql(`CREATE DATABASE ${database} TEMPLATE ajtool_restored;`);
  sql(`REVOKE CREATE,TEMP ON DATABASE ${database} FROM PUBLIC,ajtool_service; GRANT CONNECT ON DATABASE ${database} TO ajtool_service;`,database);
  const url=new URL(localUrl);url.hostname='db';url.port='5432';url.pathname='/'+database;
  const file=priv+'real-staging-'+tag+'.env';
  if(!existsSync(file))writeFileSync(file,`PORT=${port}\nDATABASE_URL=${url}\nDATABASE_REQUIRED=true\nNODE_ENV=production\nAJTOOL_ENVIRONMENT=staging\nCORE_PUBLISH=shadow\nPOLL_ENABLED=false\nOIDC_ISSUER=\nTOOL_API_KEY=\nISOTOOLS_API_URL=\nISOTOOLS_API_KEY=\nOIDC_REDIRECT_URI=https://${tag==='cpk'?'ccp':'rma'}.orcalabs.mx/auth/callback\n`,{flag:'wx',mode:0o600});
  const name='ajtool-real-staging-'+tag+'-20261101';
  if(spawnSync('docker',['container','inspect',name],{windowsHide:true}).status!==0)run(['run','-d','--name',name,'--label','ajtool.real-staging=true','--network',network,'--network-alias',tag,'--env-file',file,'-p',`127.0.0.1::${port}`,`ajtool-${tag}-rc:20261030-final-db`]);
  assert.equal(run(['inspect','--format','{{index .Config.Labels "ajtool.real-staging"}}',name]),'true');
  const appNetworks=JSON.parse(run(['inspect','--format','{{json .NetworkSettings.Networks}}',name]));
  if(!appNetworks[access])run(['network','connect',access,name]);
  const mapped=JSON.parse(run(['inspect','--format','{{json .NetworkSettings.Ports}}',name]))[port+'/tcp'][0];assert.equal(mapped.HostIp,'127.0.0.1');
  const base='http://127.0.0.1:'+mapped.HostPort;
  const ready=await waitReady(base);assert.equal(ready.persistence.tier,'postgres');assert.equal(ready.persistence.durable,true);assert.equal(ready.publish,'shadow');assert.equal(ready.auth,'open');assert.equal(ready.poller.enabled,false);
  const payload=JSON.parse(readFileSync(root+`db/test/fixtures/checkpoint-demo/${tag}-payload.json`));
  const expected=JSON.parse(readFileSync(root+'db/test/fixtures/checkpoint-demo/expected.json'))[tag];
  const headers={'content-type':'application/json'};
  const response=await fetch(base+'/api/studies',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(response.status,201);
  let study=(await response.json()).study;
  for(const [key,value] of Object.entries(expected)){const tolerance=tag==='cpk'?(key.startsWith('sigma')?0.00000051:0.000051):(key==='gageRRPercent'?0.0051:0.00000051);if(key==='ndc')assert.equal(study.result[key],value);else assert.ok(Math.abs(study.result[key]-value)<tolerance);}
  assert.equal((await fetch(`${base}/api/studies/${study.id}/publish`,{method:'POST',headers,body:'{}'})).status,200);
  study=(await (await fetch(`${base}/api/studies/${study.id}`)).json()).study;
  const ui=await fetch(base+'/');assert.equal(ui.status,200);assert.match(await ui.text(),/<div id="root"><\/div>/);
  const shadow=sql(`SELECT count(*) FROM public.event_outbox WHERE mode='shadow' AND state='shadow_recorded' AND study_id='${study.id}'`,database);assert.equal(shadow,'1');
  instances.push({tag,name,base,study,database});
  state.tools[tag]={base,studyCreated:true,independentCalculationFixture:true,recoveredById:true,uiServed:true,shadowOutbox:true};
 }
 const refreshBase=instance=>{const target=instance.tag==='cpk'?'8108/tcp':'8109/tcp';const mapping=JSON.parse(run(['inspect','--format','{{json .NetworkSettings.Ports}}',instance.name]))[target][0];assert.equal(mapping.HostIp,'127.0.0.1');instance.base='http://127.0.0.1:'+mapping.HostPort;state.tools[instance.tag].base=instance.base;};
 for(const instance of instances){run(['restart',instance.name]);refreshBase(instance);await waitReady(instance.base);assert.deepEqual((await (await fetch(`${instance.base}/api/studies/${instance.study.id}`)).json()).study,instance.study);state.tools[instance.tag].exactAfterAppRestart=true;}
 run(['stop',db]);
 for(const instance of instances){let closed=false;try{const r=await fetch(instance.base+'/ready',{signal:AbortSignal.timeout(7000)});closed=r.status===503;}catch{}state.tools[instance.tag].databaseUnavailableReady503=closed;assert.ok(closed);}
 run(['start',db]);
 for(const instance of instances){await waitReady(instance.base);assert.deepEqual((await (await fetch(`${instance.base}/api/studies/${instance.study.id}`)).json()).study,instance.study);state.tools[instance.tag].exactAfterPostgresRestart=true;}
 const databasePort=JSON.parse(run(['inspect','--format','{{json .NetworkSettings.Ports}}',db]))['5432/tcp'][0].HostPort;
 for(const [file,key] of [['restore.env','AJTOOL_RESTORE_DATABASE_URL'],['restored-runtime.env','AJTOOL_RESTORED_RUNTIME_DATABASE_URL']]){
  const content=readFileSync(priv+file,'utf8');const line=content.split(/\r?\n/).find(l=>l.startsWith(key+'='));const url=new URL(line.slice(key.length+1));url.port=databasePort;writeFileSync(priv+file,content.replace(line,key+'='+url.toString()),{mode:0o600});
 }
 writeFileSync(priv+'real-staging-synthetic-studies.json',JSON.stringify(Object.fromEntries(instances.map(x=>[x.tag,x.study.id]))),{flag:'wx',mode:0o600});
 state.status='REAL_RESTORED_STAGING_ACCEPTANCE_PASS';writeFileSync(ev+'staging-acceptance.json',JSON.stringify(state,null,2)+'\n');console.log(JSON.stringify(state));
}catch(error){state.status='STAGING_ACCEPTANCE_BLOCKED';state.reason=/^[A-Z_]+$/.test(error.message)?error.message:'STAGING_ASSERTION_FAILED';writeFileSync(ev+'staging-acceptance.json',JSON.stringify(state,null,2)+'\n');console.log(JSON.stringify(state));process.exitCode=2;}

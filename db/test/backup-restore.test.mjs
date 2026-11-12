import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {sealArchive,openArchive} from '../backup/archive.mjs';
import {prepare,fixture,container,root,quiet} from './helpers/isolated-postgres.mjs';
import {runStartup} from './helpers/startup-process.mjs';
import {inspectCatalog} from '../review/check-supabase-target.mjs';
const tables=['consumer_cursors','delivery_gates','event_inbox','event_outbox','event_rejections','manual_commands','outbox_attempts','runtime_identity','schema_migrations','settings','settings_history','spec_cache','studies'];
const sha=data=>createHash('sha256').update(data).digest('hex');
async function snapshot(pool){
 const data={};for(const name of tables)data[name]=(await pool.query(`SELECT row_to_json(t)::text AS document FROM public."${name}" t ORDER BY row_to_json(t)::text`)).rows.map(r=>r.document);
 return data;
}
function dockerBytes(args,input){
 const result=spawnSync('docker',args,{input,windowsHide:true,timeout:60000,maxBuffer:20*1024*1024});
 assert.equal(result.status,0,'Isolated dump/restore command must succeed');return result.stdout;
}
test('encrypted PostgreSQL archive rejects a wrong key and altered metadata',()=>{
 const key=randomBytes(32),data=Buffer.from('synthetic-only');const archive=sealArchive(data,key,{scope:'synthetic'});
 assert.deepEqual(openArchive(archive,key).data,data);
 assert.throws(()=>openArchive(archive,randomBytes(32)),/backup_authentication_failed/);
 const changed=JSON.parse(archive);changed.header.metadata.scope='changed';assert.throws(()=>openArchive(Buffer.from(JSON.stringify(changed)),key),/backup_authentication_failed/);
 key.fill(0);
});
for(const [tag,service] of [['cpk','calculate-cpk-ppk'],['msa','run-msa-analysis']])test(`${service}: encrypted backup restores all 13 tables in separate local fixture and recovers through API`,async()=>{
 const remote=prepare(),source=await fixture(service,remote),target=await fixture(service,remote);
 const payload=JSON.parse(readFileSync(new URL(`./fixtures/checkpoint-demo/${tag}-payload.json`,import.meta.url),'utf8'));
 const environment={TOOL_API_KEY:'',OIDC_ISSUER:'',AJTOOL_ENVIRONMENT:'staging',NODE_ENV:'production'};
 let saved,outbox;
 try{
  const first=await runStartup(service,source.url,{healthy:true,environment,exercise:async({base})=>{
   let r=await fetch(base+'/api/studies',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});assert.equal(r.status,201);saved=(await r.json()).study;
   r=await fetch(`${base}/api/studies/${saved.id}/publish`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,200);
   saved=(await (await fetch(`${base}/api/studies/${saved.id}`)).json()).study;
  }});assert.equal(first.code,0);
  await source.store.setCursor('backup-verification','9007199254740993');
  await source.store.upsertSpec({partId:'BACKUP-SYNTHETIC',characteristicId:'D',lsl:1,usl:2,version:'test-v1',sourceSeq:'9007199254740993',sourceEventId:'synthetic-backup-spec'});
  for(let version=1;version<=2;version++)assert.equal((await source.store.saveSettings({key:'backup-criteria',doc:{limit:version},expectedVersion:version-1,actor:{ref:'synthetic-engineer'},reason:'synthetic-backup-verification'})).durable,true);
  const rejected=await source.store.processEventTransaction({tool:service.replace(/-/g,'_'),consumer:'backup-rejection',event:{eventId:'synthetic-backup-rejected',sourceSeq:'11',rawInput:{synthetic:true},canonicalInput:{synthetic:true},inputHash:sha(JSON.stringify({synthetic:true}))},cursor:{name:'backup-rejection',targetSeq:'11'},handler:async tx=>{tx.reject({code:'SYNTHETIC_NO_DATA',reason:'Synthetic backup test rejection'});}});
  assert.equal(rejected.outcome,'rejected');
  const catalog=await inspectCatalog(source.pool);assert.equal(catalog.runtimeContractValid,true);assert.equal(catalog.migrationsMatch,true);assert.deepEqual(catalog.missingTables,[]);assert.equal(catalog.clientTlsVerified,false); // This fixture is private loopback, not a public target.
  const before=await snapshot(source.pool);
  outbox=(await source.pool.query('SELECT * FROM public.event_outbox WHERE study_id=$1',[saved.id])).rows;
  assert.equal(outbox.length,1);assert.equal(outbox[0].state,'shadow_recorded');
  const dump=dockerBytes(['exec',container,'pg_dump','-U',source.owner,'-d',source.db,'-Fc','--no-owner','--no-acl']);
  const key=randomBytes(32),encrypted=sealArchive(dump,key,{scope:'isolated-synthetic-fixture',tool:service});
  assert.ok(!encrypted.includes(Buffer.from(saved.id)),'Ciphertext must not reveal study ID');
  const recovered=openArchive(encrypted,key);assert.deepEqual(recovered.data,dump);
  dockerBytes(['exec','-i',container,'pg_restore','-U',target.owner,'-d',target.db,'--clean','--if-exists','--no-owner','--no-acl','--exit-on-error'],recovered.data);
  assert.deepEqual(await snapshot(target.ownerPool),before,'All rows exact before starting restored runtime');
  target.runFile('runtime-role.sql');
  const restored=await target.createStore({databaseUrl:target.url,databaseRequired:true,failFast:true,log:quiet});
  try{assert.equal(await restored.ping(),true);assert.equal(String(await restored.getCursor('backup-verification')),'9007199254740993');assert.equal((await restored.getSettings('backup-criteria')).version,2);assert.equal((await restored.listSettingsHistory('backup-criteria',20)).length,2);assert.equal((await restored.getInboxRecord(service.replace(/-/g,'_'),'synthetic-backup-rejected')).outcome,'rejected');}finally{await restored.close();}
  for(let iteration=0;iteration<2;iteration++){
   const boot=await runStartup(service,target.url,{healthy:true,environment,exercise:async({base})=>{
    const r=await fetch(`${base}/api/studies/${saved.id}`);assert.equal(r.status,200);assert.deepEqual((await r.json()).study,saved);
    assert.deepEqual((await target.pool.query('SELECT * FROM public.event_outbox WHERE study_id=$1',[saved.id])).rows,outbox);
   }});assert.equal(boot.code,0);
  }
  const output=resolve(root,process.env.AJTOOL_TEST_EVIDENCE||'artifacts/backup-restore');mkdirSync(output,{recursive:true});
  writeFileSync(resolve(output,`backup-restore-${tag}.json`),JSON.stringify({status:'PASS',scope:'temporary local fixture only',tool:service,encryptedArchiveVerified:true,all13TablesExactBeforeBoot:true,counts:Object.fromEntries(Object.entries(before).map(([k,v])=>[k,v.length])),dataSha256:sha(JSON.stringify(before)),dumpSha256:recovered.sha256,studyAndOutboxExactAfterTwoBoots:true,cursorBeyondSafeIntegerPreserved:true,productionTouched:false,liveEventsSent:false,archiveKeyRetained:false},null,2));
  key.fill(0);
 }finally{await source.close();await target.close();}
});

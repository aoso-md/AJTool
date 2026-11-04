import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepare,fixture,container,docker,sql,quiet,root,waitReady} from './helpers/isolated-postgres.mjs';
import {runStartup} from './helpers/startup-process.mjs';
import {inspectCatalog} from '../review/check-supabase-target.mjs';
import {validateRuntime} from '../../tools/calculate-cpk-ppk/src/platform/postgres-contract.js';
import {sealArchive,openArchive} from '../backup/archive.mjs';

assert.match(container,/^ajtool-durability-ci-[a-f0-9]+$/);
const tables=['consumer_cursors','delivery_gates','event_inbox','event_outbox','event_rejections','manual_commands','outbox_attempts','runtime_identity','schema_migrations','settings','settings_history','spec_cache','studies'];
const legacyTables=['studies','consumer_cursors','spec_cache','settings','settings_history'];
const apiRoles=['anon','authenticated','service_role'];
const sha=x=>createHash('sha256').update(x).digest('hex');
const env={TOOL_API_KEY:'',OIDC_ISSUER:'',AJTOOL_ENVIRONMENT:'staging',NODE_ENV:'production'};
function file(f,name){return docker(['exec',container,'psql','-X','-v','ON_ERROR_STOP=1','-v',`runtime_role=${f.role}`,'-v',`backup_manifest_sha256=${'b'.repeat(64)}`,'-v','ajtool_private_sql_approved=I_APPROVE_PRIVATE_AJTOOL_SQL','-U',f.owner,'-d',f.db,'-f',`${f.remote}/${name}`],false);}
function bytes(args,input){const r=spawnSync('docker',args,{input,windowsHide:true,timeout:60000,maxBuffer:20*1024*1024});assert.equal(r.status,0,'Fixture dump/restore must succeed');return r.stdout;}
async function snapshot(pool,names=tables){const out={};for(const t of names)out[t]=(await pool.query(`SELECT row_to_json(t)::text AS doc FROM public.${t} t ORDER BY row_to_json(t)::text`)).rows.map(x=>x.doc);return out;}
async function oldState(service){
 const remote=prepare(),f=await fixture(service,remote);
 for(const r of apiRoles)sql('ajtool_test',`CREATE ROLE ${r} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
 const now=new Date().toISOString();
 await f.store.saveStudy({id:'synthetic-historical-'+service,tool:service.replaceAll('-','_'),status:'completed',createdAt:now,updatedAt:now,input:{synthetic:true},result:{unchanged:true}});
 for(let i=0;i<25;i++)await f.store.upsertSpec({partId:'SYNTHETIC-'+i,characteristicId:'D',lsl:1,usl:2,version:'v1',sourceSeq:String(i+1),sourceEventId:'synthetic-spec-'+i});
 for(let i=0;i<3;i++)await f.store.setCursor('synthetic-cursor-'+i,String(i+3));
 await f.store.saveSettings({key:'synthetic-criteria',doc:{limit:1},expectedVersion:0,actor:{ref:'synthetic'},reason:'preservation-proof'});
 sql(f.db,'DROP TABLE delivery_gates,outbox_attempts,manual_commands,event_rejections,event_outbox,event_inbox,runtime_identity,schema_migrations CASCADE',f.owner);
 sql(f.db,'ALTER TABLE consumer_cursors DROP COLUMN generation; DROP FUNCTION public.ajtool_validate_schema()',f.owner);
 for(const t of legacyTables)sql(f.db,`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY; CREATE POLICY ajtool_service_all ON ${t} TO ${f.role} USING(true) WITH CHECK(true); GRANT ALL ON ${t} TO anon,authenticated,service_role;`,f.owner);
 sql(f.db,`GRANT TEMPORARY ON DATABASE ${f.db} TO PUBLIC`,f.owner);
 sql(f.db,`CREATE SCHEMA extensions; REVOKE ALL ON SCHEMA extensions FROM PUBLIC; CREATE VIEW extensions.pg_stat_statements AS SELECT 1 AS synthetic; CREATE VIEW extensions.pg_stat_statements_info AS SELECT 2 AS synthetic; GRANT SELECT ON extensions.pg_stat_statements,extensions.pg_stat_statements_info TO PUBLIC; GRANT USAGE ON SCHEMA extensions TO anon;`,f.owner);
 return Object.assign(f,{remote});
}
async function close(f){await f.close();for(const r of apiRoles)sql('ajtool_test',`DROP ROLE ${r}`);}
async function denied(pool,query){await assert.rejects(pool.query(query),e=>e.code==='42501');}
function deniedRole(f,role,query){const r=docker(['exec',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','ajtool_migrator','-d',f.db,'-Atc',`SET ROLE ${role}; ${query}`],false);assert.notEqual(r.status,0);assert.match(r.stderr,/permission denied/);}
async function dataApiDenied(f){
 for(const r of apiRoles){
  deniedRole(f,r,'SELECT * FROM public.studies');
  deniedRole(f,r,"UPDATE public.studies SET doc='{}'::jsonb");
  deniedRole(f,r,"SELECT public.ajtool_validate_schema()");
 }
 assert.equal(sql(f.db,"SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND (EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) OR EXISTS(SELECT 1 FROM pg_attribute att CROSS JOIN LATERAL aclexplode(att.attacl) a WHERE att.attrelid=c.oid AND a.grantee=0))",f.owner),'0');
}

for(const service of ['calculate-cpk-ppk','run-msa-analysis'])test(`${service}: namespace-aware adoption preserves history, denies Data API and recovers API after restart`,async()=>{
 const f=await oldState(service);
 try{
  const before=await snapshot(f.ownerPool,legacyTables);
  const providerBefore=sql(f.db,"SELECT relacl::text FROM pg_class WHERE oid IN ('extensions.pg_stat_statements'::regclass,'extensions.pg_stat_statements_info'::regclass) ORDER BY relname",f.owner);
  assert.equal(sql(f.db,`SELECT has_table_privilege('${f.role}','extensions.pg_stat_statements','SELECT') AND NOT has_schema_privilege('${f.role}','extensions','USAGE')`,f.owner),'t');
  await denied(f.pool,'SELECT * FROM extensions.pg_stat_statements');
  const out=resolve(root,process.env.AJTOOL_TEST_EVIDENCE||'artifacts/supabase-reconciliation-20261029');mkdirSync(out,{recursive:true});
  const catalogSQL=readFileSync(resolve(root,'db/review/supabase-inventory.sql'),'utf8').replaceAll('ajtool_service',f.role);
  const oldCatalog=await f.ownerPool.query(catalogSQL);
  writeFileSync(resolve(out,'legacy-catalog-'+service+'.json'),JSON.stringify({origin:'isolated_synthetic_supabase_like',catalog:oldCatalog.find(x=>x.rows?.[0]?.ajtool_readonly_inventory)?.rows[0].ajtool_readonly_inventory},null,2));
  const adopted=file(f,'supabase-private-adoption.sql');assert.equal(adopted.status,0,adopted.stderr);
  const newCatalog=await f.ownerPool.query(catalogSQL);
  writeFileSync(resolve(out,'candidate-catalog-'+service+'.json'),JSON.stringify({origin:'isolated_candidate',catalog:newCatalog.find(x=>x.rows?.[0]?.ajtool_readonly_inventory)?.rows[0].ajtool_readonly_inventory},null,2));
  const after=await snapshot(f.ownerPool,legacyTables);
  const oldCursors=before.consumer_cursors.map(JSON.parse);
  const newCursors=after.consumer_cursors.map(x=>{const r=JSON.parse(x);delete r.generation;return r;});
  assert.deepEqual(newCursors,oldCursors,'Cursor values and timestamps exact, excluding additive generation');
  delete before.consumer_cursors;delete after.consumer_cursors;assert.deepEqual(after,before,'Legacy documents and timestamps exact');
  assert.equal(sql(f.db,'SELECT count(*) FROM consumer_cursors WHERE generation=1',f.owner),'3');
  assert.equal(sql(f.db,"SELECT count(*) FROM pg_tables WHERE schemaname='public'",f.owner),'13');
  assert.equal(sql(f.db,'SELECT count(*) FROM public.schema_migrations',f.owner),'3');
  assert.equal(sql(f.db,"SELECT relacl::text FROM pg_class WHERE oid IN ('extensions.pg_stat_statements'::regclass,'extensions.pg_stat_statements_info'::regclass) ORDER BY relname",f.owner),providerBefore);
  assert.equal(sql(f.db,`SELECT has_schema_privilege('${f.role}','extensions','USAGE')`,f.owner),'f');
  await denied(f.pool,'SELECT * FROM extensions.pg_stat_statements');
  assert.equal(sql(f.db,'SET ROLE anon; SELECT synthetic FROM extensions.pg_stat_statements').split('\n').at(-1),'1','Provider consumer remains unchanged');
  await dataApiDenied(f);
  await validateRuntime(f.pool);assert.deepEqual((await inspectCatalog(f.pool)).findings,[]);
  const payload=JSON.parse(readFileSync(new URL(`./fixtures/checkpoint-demo/${service.startsWith('calculate')?'cpk':'msa'}-payload.json`,import.meta.url),'utf8'));
  let saved;
  const boot=await runStartup(service,f.url,{healthy:true,environment:env,exercise:async({base})=>{
   const response=await fetch(base+'/api/studies',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});assert.equal(response.status,201);saved=(await response.json()).study;
   assert.deepEqual((await(await fetch(base+'/api/studies/'+saved.id)).json()).study,saved);
  }});assert.equal(boot.code,0);
  const allBefore=await snapshot(f.ownerPool);
  docker(['restart',container]);await waitReady(); // only the runner-owned disposable fixture
  for(let i=0;i<2;i++){
   const reopen=await runStartup(service,f.url,{healthy:true,environment:env,exercise:async({base})=>{
    assert.deepEqual((await(await fetch(base+'/api/studies/'+saved.id)).json()).study,saved);
   }});assert.equal(reopen.code,0);
  }
  assert.deepEqual(await snapshot(f.ownerPool),allBefore,'All thirteen tables exact after DB restart and two API starts');
  writeFileSync(resolve(out,'compatibility-'+service+'.json'),JSON.stringify({status:'PASS',origin:'synthetic fixture; provider views simulated, not full Supabase image',version:sql(f.db,"SELECT current_setting('server_version')",f.owner),rows:Object.fromEntries(Object.entries(allBefore).map(([k,v])=>[k,v.length])),legacyDocumentsExact:true,thirteenTablesExactAfterRestart:true,providerAclUnchanged:true,missingSchemaUsageStillDenied:true,dataApiDenied:true,remoteTouched:false},null,2));
 }finally{await close(f);}
});

test('granting provider schema USAGE makes foreign SELECT reachable and blocks before any migration change',async()=>{
 const f=await oldState('calculate-cpk-ppk');try{
  sql(f.db,`GRANT USAGE ON SCHEMA extensions TO ${f.role}`,f.owner);
  const before=await snapshot(f.ownerPool,legacyTables),r=file(f,'supabase-private-adoption.sql');
  assert.notEqual(r.status,0);assert.match(r.stderr,/provider ACL review required/);
  assert.deepEqual(await snapshot(f.ownerPool,legacyTables),before);
  assert.equal(sql(f.db,"SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity",f.owner),'5');
  assert.equal(sql(f.db,"SELECT to_regclass('public.schema_migrations') IS NULL",f.owner),'t');
 }finally{await close(f);}
});

test('column-only foreign privilege is rejected as soon as namespace is reachable',async()=>{
 const f=await oldState('calculate-cpk-ppk');try{
  assert.equal(file(f,'supabase-private-adoption.sql').status,0);
  sql(f.db,`CREATE SCHEMA foreign_scope; CREATE TABLE foreign_scope.data (id int); GRANT SELECT(id) ON foreign_scope.data TO ${f.role}`,f.owner);
  await validateRuntime(f.pool);await denied(f.pool,'SELECT id FROM foreign_scope.data');
  sql(f.db,`GRANT USAGE ON SCHEMA foreign_scope TO ${f.role}`,f.owner);
  await assert.rejects(validateRuntime(f.pool));
 }finally{await close(f);}
});

test('inaccessible SECURITY DEFINER stays denied; schema grant triggers startup refusal',async()=>{
 const f=await oldState('calculate-cpk-ppk');try{
  assert.equal(file(f,'supabase-private-adoption.sql').status,0);
  sql(f.db,"CREATE SCHEMA function_scope; CREATE FUNCTION function_scope.test_only() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'; GRANT EXECUTE ON FUNCTION function_scope.test_only() TO PUBLIC",f.owner);
  await validateRuntime(f.pool);await denied(f.pool,'SELECT function_scope.test_only()');
  sql(f.db,`GRANT USAGE ON SCHEMA function_scope TO ${f.role}`,f.owner);
  await assert.rejects(validateRuntime(f.pool));
 }finally{await close(f);}
});

test('revoked DML, unapproved RLS and cross-schema access all fail closed after adoption',async()=>{
 const f=await oldState('calculate-cpk-ppk');try{
  assert.equal(file(f,'supabase-private-adoption.sql').status,0);
  sql(f.db,`REVOKE INSERT ON studies FROM ${f.role}`,f.owner);
  await assert.rejects(validateRuntime(f.pool));
  await denied(f.pool,"INSERT INTO studies(id,tool,status,created_at,updated_at,doc) VALUES('synthetic-denied','calculate_cpk_ppk','completed',now(),now(),'{}')");
  sql(f.db,`GRANT INSERT ON studies TO ${f.role}; ALTER TABLE studies ENABLE ROW LEVEL SECURITY; DROP POLICY ajtool_service_all ON studies`,f.owner);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM studies')).rows[0].n,0);
  await assert.rejects(validateRuntime(f.pool));
 }finally{await close(f);}
});

test('private adoption removes public-schema migrator defaults without changing provider-schema defaults',async()=>{
 const f=await oldState('calculate-cpk-ppk');try{
  sql(f.db,'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO anon',f.owner);
  const globalRejected=file(f,'supabase-private-adoption.sql');assert.notEqual(globalRejected.status,0);assert.match(globalRejected.stderr,/global migrator defaults/);
  assert.equal(sql(f.db,"SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity",f.owner),'5');
  sql(f.db,'ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM anon',f.owner);
  sql(f.db,'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon,authenticated,service_role; CREATE SCHEMA provider_defaults; ALTER DEFAULT PRIVILEGES IN SCHEMA provider_defaults GRANT SELECT ON TABLES TO anon',f.owner);
  const providerDefaults=sql(f.db,"SELECT defaclacl::text FROM pg_default_acl WHERE defaclnamespace='provider_defaults'::regnamespace",f.owner);
  const result=file(f,'supabase-private-adoption.sql');assert.equal(result.status,0,result.stderr);
  sql(f.db,'CREATE TABLE public.future_private_fixture(id bigserial PRIMARY KEY, doc jsonb)',f.owner);
  for(const role of apiRoles){
   assert.equal(sql(f.db,`SELECT has_table_privilege('${role}','public.future_private_fixture','SELECT,INSERT,UPDATE,DELETE') OR has_any_column_privilege('${role}','public.future_private_fixture','SELECT,INSERT,UPDATE,REFERENCES')`),'f');
   assert.equal(sql(f.db,`SELECT has_sequence_privilege('${role}','public.future_private_fixture_id_seq','USAGE,SELECT,UPDATE')`),'f');
  }
  assert.equal(sql(f.db,"SELECT defaclacl::text FROM pg_default_acl WHERE defaclnamespace='provider_defaults'::regnamespace",f.owner),providerDefaults);
 }finally{await close(f);}
});

test('legacy encrypted backup restores schema, RLS, ACL and documents after a committed synthetic adoption',async()=>{
 const f=await oldState('calculate-cpk-ppk');let target;
 try{
  const before=await snapshot(f.ownerPool,legacyTables);
  const preAcl=sql(f.db,"SELECT relname,relacl::text,relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname",f.owner);
  const prePolicy=sql(f.db,"SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename",f.owner);
  const dump=bytes(['exec',container,'pg_dump','-U',f.owner,'-d',f.db,'-Fc']);
  const key=randomBytes(32),archive=sealArchive(dump,key,{scope:'synthetic-legacy-rollback'});
  assert.equal(file(f,'supabase-private-adoption.sql').status,0);
  // A clean independent database is the recovery target; never overwrite the source.
  const db='rollback_'+randomBytes(8).toString('hex');sql('ajtool_test',`CREATE DATABASE ${db} OWNER ${f.owner}`);target=db;
  bytes(['exec','-i',container,'pg_restore','-U','ajtool_migrator','-d',db,'--exit-on-error'],openArchive(archive,key).data);
  const {Pool}=await import('./helpers/isolated-postgres.mjs');
  const u=new URL(f.ownerUrl);u.pathname='/'+db;const p=new Pool({connectionString:u.href,ssl:false});
  try{assert.deepEqual(await snapshot(p,legacyTables),before);}finally{await p.end();}
  assert.equal(sql(db,"SELECT relname,relacl::text,relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname",f.owner),preAcl);
  assert.equal(sql(db,"SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename",f.owner),prePolicy);
  assert.equal(sql(db,"SELECT to_regclass('public.schema_migrations') IS NULL",f.owner),'t');
  assert.equal(sql(db,`SELECT has_database_privilege('${f.role}',current_database(),'TEMP')`,f.owner),'t','Legacy database ACL restored');
  key.fill(0);
 }finally{if(target)sql('ajtool_test',`DROP DATABASE ${target} WITH (FORCE)`);await close(f);}
});

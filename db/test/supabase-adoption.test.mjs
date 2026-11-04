import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectCatalog} from '../review/check-supabase-target.mjs';
import {prepare,fixture,container,docker,sql,quiet} from './helpers/isolated-postgres.mjs';
assert.match(container,/^ajtool-durability-ci-[a-f0-9]+$/,'Adoption tests require the disposable labelled runner');
const dataRoles=['anon','authenticated','service_role'];
async function legacy(service){
 const remote=prepare(),f=await fixture(service,remote);
 for(const role of dataRoles)sql('ajtool_test',`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
 const now=new Date().toISOString();
 await f.store.saveStudy({id:'legacy-synthetic-study',tool:service.replace(/-/g,'_'),status:'completed',createdAt:now,updatedAt:now,input:{synthetic:true},result:{testOnly:true}});
 await f.store.saveSettings({key:'legacy-synthetic-criteria',doc:{limit:1},expectedVersion:0,actor:{ref:'synthetic'},reason:'migration-test'});
 sql(f.db,'DROP TABLE delivery_gates,outbox_attempts,manual_commands,event_rejections,event_outbox,event_inbox,runtime_identity,schema_migrations CASCADE',f.owner);
 sql(f.db,'ALTER TABLE consumer_cursors DROP COLUMN generation; DROP FUNCTION public.ajtool_validate_schema()',f.owner);
 for(const name of ['studies','consumer_cursors','spec_cache','settings','settings_history'])sql(f.db,`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`,f.owner);
 sql(f.db,`GRANT TEMPORARY ON DATABASE ${f.db} TO PUBLIC; GRANT SELECT ON studies TO anon; GRANT UPDATE(doc) ON studies TO authenticated; CREATE POLICY legacy_runtime ON studies TO ${f.role} USING (true) WITH CHECK (true);`,f.owner);
 return Object.assign(f,{remote});
}
async function cleanup(f){await f.close();for(const role of dataRoles)sql('ajtool_test',`DROP ROLE ${role}`);}
function adopt(f,{approved=true}={}){
 return docker(['exec',container,'psql','-X','-v','ON_ERROR_STOP=1','-v',`runtime_role=${f.role}`,'-v',`backup_manifest_sha256=${'a'.repeat(64)}`,...(approved?['-v','ajtool_private_sql_approved=I_APPROVE_PRIVATE_AJTOOL_SQL']:[]),'-U',f.owner,'-d',f.db,'-f',`${f.remote}/supabase-private-adoption.sql`],false);
}
for(const service of ['calculate-cpk-ppk','run-msa-analysis'])test(`${service}: legacy RLS schema adopts atomically without granting Data API access`,async()=>{
 const f=await legacy(service);
 try{
  const before=sql(f.db,'SELECT doc::text FROM studies',f.owner);
  const result=adopt(f);assert.equal(result.status,0,result.stderr);
  assert.equal(sql(f.db,'SELECT doc::text FROM studies',f.owner),before);
  assert.equal(sql(f.db,'SELECT count(*) FROM schema_migrations',f.owner),'3');
  assert.equal(sql(f.db,"SELECT count(*) FROM pg_tables WHERE schemaname='public'",f.owner),'13');
  assert.equal(sql(f.db,"SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity",f.owner),'0');
  assert.equal(sql(f.db,"SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='legacy_runtime'",f.owner),'1','Existing policies remain available for reviewed rollback');
  assert.equal(sql(f.db,"SELECT has_table_privilege('anon','studies','SELECT') OR has_column_privilege('authenticated','studies','doc','UPDATE')",f.owner),'f');
  assert.equal(sql(f.db,`SELECT has_database_privilege('${f.role}',current_database(),'TEMP')`,f.owner),'f');
  assert.equal(sql(f.db,"SELECT has_database_privilege('anon',current_database(),'TEMP')",f.owner),'t','Other existing role capabilities are preserved');
  const preflight=await inspectCatalog(f.pool);
  assert.deepEqual(preflight.findings,[]);
  assert.equal(preflight.dataApiRoles.length,3);
  assert.ok(preflight.dataApiRoles.every(r=>r.accessible_tables===0));
  const fresh=await f.createStore({databaseUrl:f.url,databaseRequired:true,failFast:true,log:quiet});try{assert.equal(await fresh.ping(),true);}finally{await fresh.close();}
 }finally{await cleanup(f);}
});
test('adoption refuses missing approval and unrelated public project objects without changes',async()=>{
 const f=await legacy('calculate-cpk-ppk');
 try{
  assert.notEqual(adopt(f,{approved:false}).status,0);
  sql(f.db,'CREATE SCHEMA provider_metadata; CREATE VIEW provider_metadata.stats AS SELECT 1 AS synthetic; GRANT SELECT ON provider_metadata.stats TO PUBLIC',f.owner);
  sql(f.db,`GRANT USAGE ON SCHEMA provider_metadata TO ${f.role}`,f.owner);
  const providerRejected=adopt(f);assert.notEqual(providerRejected.status,0);assert.match(providerRejected.stderr,/provider ACL review required before changes/);
  assert.equal(sql(f.db,"SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity",f.owner),'5');
  assert.equal(sql(f.db,"SELECT has_table_privilege('anon','provider_metadata.stats','SELECT')",f.owner),'t');
  sql(f.db,'DROP SCHEMA provider_metadata CASCADE',f.owner);
  sql(f.db,'CREATE TABLE marli_separation_guard(id int); GRANT SELECT ON marli_separation_guard TO anon',f.owner);
  const rejected=adopt(f);assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/unrelated public objects/);
  assert.equal(sql(f.db,"SELECT has_table_privilege('anon','marli_separation_guard','SELECT')",f.owner),'t');
  assert.equal(sql(f.db,"SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity",f.owner),'5');
  assert.equal(sql(f.db,"SELECT to_regclass('public.schema_migrations') IS NULL",f.owner),'t');
 }finally{await cleanup(f);}
});
test('failed schema adoption rolls back RLS, API grants, DDL and runtime permissions',async()=>{
 const f=await legacy('calculate-cpk-ppk');
 try{
  sql(f.db,'ALTER TABLE studies RENAME COLUMN doc TO broken_doc',f.owner);
  assert.notEqual(adopt(f).status,0);
  assert.equal(sql(f.db,"SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity",f.owner),'5');
  assert.equal(sql(f.db,"SELECT has_table_privilege('anon','studies','SELECT')",f.owner),'t');
  assert.equal(sql(f.db,`SELECT has_database_privilege('${f.role}',current_database(),'TEMP')`,f.owner),'t');
  assert.equal(sql(f.db,"SELECT to_regclass('public.schema_migrations') IS NULL",f.owner),'t');
  const invalid=docker(['exec',container,'psql','-X','-v','ON_ERROR_STOP=1','-v','ajtool_external_transaction=1','-U',f.owner,'-d',f.db,'-f',`${f.remote}/migrate.sql`],false);
  assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/guarded outer transaction required/);
 }finally{await cleanup(f);}
});

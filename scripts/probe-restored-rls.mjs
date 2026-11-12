import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const {Client}=createRequire(new URL('../tools/calculate-cpk-ppk/package.json',import.meta.url))('pg');
const u=new URL(process.env.AJTOOL_RESTORE_DATABASE_URL||'');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.pathname,'/ajtool_restored');
const client=new Client({connectionString:u.toString(),ssl:false});const results={};
try{
 await client.connect();
 for(const [name,change] of [
  ['rlsDisabledRejected','ALTER TABLE public.studies DISABLE ROW LEVEL SECURITY'],
  ['forcedRlsRemovedRejected','ALTER TABLE public.studies NO FORCE ROW LEVEL SECURITY'],
  ['publicPolicyRejected','ALTER POLICY ajtool_service_all ON public.studies TO PUBLIC'],
  ['missingPolicyRejected','DROP POLICY ajtool_service_all ON public.studies; DROP POLICY ajtool_private_runtime_v1 ON public.studies'],
  ['apiGrantRejected','GRANT SELECT ON public.studies TO anon']
 ]){
  await client.query('BEGIN');let rejected=false;
  try{await client.query(change);await client.query('SET LOCAL ROLE ajtool_service');await client.query('SELECT public.ajtool_validate_schema()');}catch(error){rejected=error.code==='P0001';}finally{await client.query('ROLLBACK');}
  assert.ok(rejected);results[name]=true;
 }
 const clone=await client.query('SELECT count(*)::int AS n FROM public.studies');assert.equal(clone.rows[0].n,1);
 results.originalStudyCountPreserved=true;
 const source=new URL('../db',import.meta.url);const copy=spawnSync('docker',['cp',decodeURIComponent(source.pathname).replace(/^\/([A-Za-z]:)/,'$1'),'ajtool-real-restore-20261101:/work-db-updated'],{windowsHide:true});assert.equal(copy.status,0);
 const again=spawnSync('docker',['exec','-i','ajtool-real-restore-20261101','psql','-X','-v','ON_ERROR_STOP=1','-v','runtime_role=ajtool_service','-v','ajtool_rls_private_contract=1','-U','postgres','-d','ajtool_restored','-f','/work-db-updated/migrate.sql'],{windowsHide:true});assert.equal(again.status,0);results.optInMigrationIdempotent=true;
 const runtimeRole=new URL(process.env.AJTOOL_RESTORED_RUNTIME_DATABASE_URL);const {Pool}=createRequire(new URL('../tools/calculate-cpk-ppk/package.json',import.meta.url))('pg');const pool=new Pool({connectionString:runtimeRole.toString(),ssl:false});
 try{const {validateRuntime}=await import('../tools/calculate-cpk-ppk/src/platform/postgres-contract.js');await validateRuntime(pool);}finally{await pool.end();}
 results.runtimeContractAfterIdempotentMigration=true;
 writeFileSync(new URL('../artifacts/real-postgres-20261101/rls-negative-probes.json',import.meta.url),JSON.stringify({status:'RLS_NEGATIVE_PROBES_PASS',...results,remoteMutations:false},null,2)+'\n');console.log(JSON.stringify({status:'RLS_NEGATIVE_PROBES_PASS',...results,remoteMutations:false}));
}catch{console.log(JSON.stringify({status:'RLS_NEGATIVE_PROBES_BLOCKED',completed:results,remoteMutations:false}));process.exitCode=2;}
finally{await client.end().catch(()=>{});}

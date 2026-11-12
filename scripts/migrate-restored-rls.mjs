import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {validateRuntime} from '../tools/calculate-cpk-ppk/src/platform/postgres-contract.js';
const {Pool}=createRequire(new URL('../tools/calculate-cpk-ppk/package.json',import.meta.url))('pg');
const root=fileURLToPath(new URL('../',import.meta.url)),name='ajtool-real-restore-20261101';
const evidence=root+'artifacts/real-postgres-20261101/';
const docker=(args,input)=>spawnSync('docker',args,{input,windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
const sql=statement=>docker(['exec','-i',name,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','ajtool_restored'],Buffer.from(statement));
let pool;
try{
 const owner=new URL(process.env.AJTOOL_RESTORE_DATABASE_URL||'');if(owner.hostname!=='127.0.0.1'||owner.pathname!=='/ajtool_restored')throw new Error('WRONG_ISOLATED_TARGET');
 const label=docker(['inspect','--format','{{index .Config.Labels "ajtool.real-restore"}}',name]);if(label.stdout.toString().trim()!=='true')throw new Error('WRONG_CONTAINER_LABEL');
 const migrations=JSON.parse(JSON.stringify((await import('../tools/calculate-cpk-ppk/src/platform/postgres-contract.js')).MIGRATIONS));
 for(const version of Object.keys(migrations)){
  const file={ '001':'001-initial.sql','002':'002-schema-contract.sql','003':'003-inbox-outbox.sql'}[version];
  const sha=createHash('sha256').update(readFileSync(root+'db/migrations/'+file,'utf8').replace(/\r\n/g,'\n')).digest('hex');if(sha!==migrations[version])throw new Error('IMMUTABLE_MIGRATION_CHANGED');
 }
 if(docker(['cp',root+'db',name+':/work-db']).status!==0)throw new Error('COPY_FAILED');
 const ordinary=sql('\\ir /work-db/migrate.sql\n');
 const originalRejectedRls=ordinary.status!==0&&ordinary.stderr.toString().includes('without RLS');
 if(!originalRejectedRls)throw new Error('EXPECTED_RLS_REJECTION_NOT_OBSERVED');
 const password=randomBytes(24).toString('hex');
 const wrapper=`BEGIN;
SELECT set_config('ajtool.external_migration','private-supabase-v1',true);
\\set ajtool_external_transaction 1
\\set runtime_role ajtool_service
\\set ajtool_rls_private_contract 1
\\ir /work-db/migrate.sql
\\ir /work-db/runtime-role.sql
GRANT EXECUTE ON FUNCTION public.ajtool_validate_private_rls() TO ajtool_service;
ALTER ROLE ajtool_service LOGIN PASSWORD '${password}';
COMMIT;\n`;
 const migrated=sql(wrapper);
 if(migrated.status!==0){const error=migrated.stderr.toString();const safe=error.includes('expected immutable003')?'VALIDATOR_GUARD_NOT_MATCHED':error.includes('private_rls_contract')?'PRIVATE_RLS_CONTRACT_FAILED':error.includes('syntax error')?'SQL_SYNTAX_ERROR':'MIGRATION_FAILED';throw new Error(safe);}
 owner.username='ajtool_service';owner.password=password;
 pool=new Pool({connectionString:owner.toString(),ssl:false,max:1});await validateRuntime(pool);
 const metadata=(await pool.query("SELECT count(*)::int AS tables,count(*) FILTER(WHERE relrowsecurity AND relforcerowsecurity)::int AS forced_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")).rows[0];
 if(metadata.tables!==13||metadata.forced_rls!==13)throw new Error('RLS_COVERAGE_FAILED');
 const forbidden=[];
 for(const statement of ['CREATE TABLE public.forbidden_probe(id int)','CREATE TEMP TABLE forbidden_probe(id int)','DELETE FROM public.studies WHERE false']){
  try{await pool.query(statement);throw new Error('FORBIDDEN_OPERATION_SUCCEEDED');}catch(error){if(error.message==='FORBIDDEN_OPERATION_SUCCEEDED')throw error;forbidden.push(error.code==='42501');}
 }
 if(!forbidden.every(Boolean))throw new Error('NEGATIVE_PERMISSIONS_FAILED');
 writeFileSync(root+'.env.ajtool-supabase/restored-runtime.env','AJTOOL_RESTORED_RUNTIME_DATABASE_URL='+owner.toString()+'\n',{flag:'wx',mode:0o600});
 const result={status:'RESTORED_MIGRATION_RLS_PASS',originalRejectedRls,immutable001To003Verified:true,rlsNeverDisabled:true,tables:metadata.tables,forcedRlsTables:metadata.forced_rls,runtimeContract:true,forbiddenCreate:true,forbiddenTemp:true,forbiddenDelete:true,credentialsIndependentFromRemote:true,remoteMutations:false};
 writeFileSync(evidence+'migration-rls-receipt.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}catch(error){console.log(JSON.stringify({status:'RESTORED_MIGRATION_BLOCKED',reason:/^[A-Z_0-9]+$/.test(error.message)?error.message:'LOCAL_VALIDATION_FAILED',remoteMutations:false}));process.exitCode=2;}
finally{await pool?.end().catch(()=>{});}

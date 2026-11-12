// Approved dedicated AJTool target only, after verified actual backup + restored acceptance.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,unlinkSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {targetDescriptor} from '../db/review/check-supabase-target.mjs';
const {Client}=createRequire(new URL('../tools/calculate-cpk-ppk/package.json',import.meta.url))('pg');
const root=fileURLToPath(new URL('../',import.meta.url)),priv=root+'.env.ajtool-supabase/',ev=root+'artifacts/real-postgres-20261101/';
let client,passFile,committed=false;
try{
 const backup=JSON.parse(readFileSync(ev+'backup-receipt.json','utf8')),restore=JSON.parse(readFileSync(ev+'restore-receipt.json','utf8')),accept=JSON.parse(readFileSync(ev+'staging-acceptance.json','utf8')),probes=JSON.parse(readFileSync(ev+'rls-negative-probes.json','utf8'));
 if(restore.status!=='REAL_RESTORE_COMPARISON_PASS'||restore.backupSha256!==backup.dumpSha256||accept.status!=='REAL_RESTORED_STAGING_ACCEPTANCE_PASS'||probes.status!=='RLS_NEGATIVE_PROBES_PASS')throw new Error('ACTUAL_BACKUP_STAGING_GATE_NOT_MET');
 const encrypted=readFileSync(priv+backup.backupPrivateFile);if(createHash('sha256').update(encrypted).digest('hex')!==backup.encryptedSha256)throw new Error('BACKUP_CHANGED');
 const url=new URL(process.env.AJTOOL_MIGRATOR_DATABASE_URL||'');const target=targetDescriptor(url.toString());if(target.mode!=='session'||decodeURIComponent(url.username)!=='postgres.lcteryhtsynrxgfpvryt'||url.pathname!=='/postgres')throw new Error('WRONG_TARGET');
 const ca=readFileSync(root+'db/review/certs/supabase-prod-ca-2021.crt');if(createHash('sha256').update(ca).digest('hex')!=='700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7')throw new Error('CA_CHANGED');
 const clean=new URL(url);for(const k of [...clean.searchParams.keys()])if(k.toLowerCase().startsWith('ssl'))clean.searchParams.delete(k);
 client=new Client({connectionString:clean.toString(),ssl:{ca,rejectUnauthorized:true,servername:url.hostname},application_name:'ajtool-approved-private-rls',connectionTimeoutMillis:10000,query_timeout:20000});await client.connect();if(!client.connection.stream.authorized)throw new Error('TLS_NOT_VERIFIED');
 const active=(await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename='ajtool_service'")).rows[0].n;if(active!==0)throw new Error('ACTIVE_RUNTIME_CLIENTS_PRESERVED');
 const inventory=readFileSync(root+'db/review/supabase-inventory.sql','utf8').replace(/^BEGIN READ ONLY;\s*SET LOCAL statement_timeout = '15000ms';\s*/,'').replace(/\s*COMMIT;\s*$/,'');
 const before=(await client.query(inventory)).rows[0].ajtool_readonly_inventory,expected=JSON.parse(readFileSync(ev+'catalog-before.json')).catalog;
 for(const key of ['tables','columns','constraints','indexes','policies','counts','historical_checks'])if(JSON.stringify(before[key])!==JSON.stringify(expected[key]))throw new Error('SOURCE_DRIFT_REQUIRES_NEW_BACKUP');
 const cursorDigest=async()=> (await client.query("SELECT md5(coalesce(string_agg((to_jsonb(c)-'generation')::text,'' ORDER BY name),'')) AS hash FROM public.consumer_cursors c")).rows[0].hash;
 const cursorsBefore=await cursorDigest();
 const esc=s=>s.replace(/\\/g,'\\\\').replace(/:/g,'\\:');passFile=priv+'migration-pass-'+randomBytes(6).toString('hex');writeFileSync(passFile,[url.hostname,'5432','postgres',decodeURIComponent(url.username),decodeURIComponent(url.password)].map(esc).join(':')+'\n',{flag:'wx',mode:0o600});
 const wrapper="BEGIN;\nSET LOCAL lock_timeout='5s';\nSELECT set_config('ajtool.external_migration','private-supabase-v1',true);\n\\set ajtool_external_transaction 1\n\\set runtime_role ajtool_service\n\\set ajtool_rls_private_contract 1\n\\ir /review/migrate.sql\n\\ir /review/runtime-role.sql\nGRANT EXECUTE ON FUNCTION public.ajtool_validate_private_rls() TO ajtool_service;\nCOMMIT;\n";
 const command='umask 077; cp /private-pass /tmp/pgpass; export PGPASSFILE=/tmp/pgpass PGSSLMODE=verify-full PGSSLROOTCERT=/official-ca; exec psql -X --no-password -v ON_ERROR_STOP=1 --host=aws-1-us-west-2.pooler.supabase.com --port=5432 --username=postgres.lcteryhtsynrxgfpvryt --dbname=postgres';
 const migrated=spawnSync('docker',['run','--rm','-i','--label','ajtool.authorized-migration=true','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--mount',`type=bind,source=${passFile},target=/private-pass,readonly`,'--mount',`type=bind,source=${root}db/review/certs/supabase-prod-ca-2021.crt,target=/official-ca,readonly`,'--mount',`type=bind,source=${root}db,target=/review,readonly`,'postgres:17','sh','-c',command],{input:wrapper,windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
 if(migrated.status!==0){const stderr=migrated.stderr?.toString()??'';writeFileSync(ev+'remote-migration-failure.json',JSON.stringify({transactionCommitted:false,errorClass:stderr.includes('permission denied')?'PERMISSION_DENIED':stderr.includes('lock timeout')?'LOCK_TIMEOUT':'TRANSACTION_REJECTED',stderrSha256:createHash('sha256').update(stderr).digest('hex')},null,2)+'\n');throw new Error('MIGRATION_TRANSACTION_REJECTED');}
 committed=true;
 const after=(await client.query(inventory)).rows[0].ajtool_readonly_inventory;
 const tables=after.tables.filter(t=>t.kind==='r'),rls=tables.every(t=>t.rls&&t.force_rls);
 if(tables.length!==13||!rls||cursorsBefore!==await cursorDigest())throw new Error('POST_MIGRATION_VERIFICATION_FAILED');
 for(const key of ['studies','spec_cache','settings','settings_history'])if(JSON.stringify(before.historical_checks[key])!==JSON.stringify(after.historical_checks[key]))throw new Error('HISTORICAL_FINGERPRINT_MISMATCH');
 const safe=(await client.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,has_database_privilege(oid,current_database(),'TEMP') AS temp FROM pg_roles WHERE rolname='ajtool_service'")).rows[0];
 const roleFlagsSafe=!['rolsuper','rolcreatedb','rolcreaterole','rolbypassrls','rolreplication','temp'].some(k=>safe[k]);
 await client.query('SELECT public.ajtool_validate_schema()');
 writeFileSync(ev+'catalog-remote-after.json',JSON.stringify({atUtc:new Date().toISOString(),projectRef:target.projectRef,catalog:after},null,2)+'\n');
 const report={status:'REMOTE_PRIVATE_RLS_SCHEMA_VERIFIED',atUtc:new Date().toISOString(),projectRef:target.projectRef,committed:true,tlsVerified:true,tables:13,forcedRlsTables:13,historyFingerprintsPreserved:true,cursorsPreserved:true,immutable001To003:true,runtimeRoleFlagsSafe:roleFlagsSafe,runtimePasswordChanged:false,runtimeAuthentication:'PENDING_PRIVATE_CREDENTIAL',officialToolsRestarted:false,orcaLive:false,backupSha256:backup.dumpSha256};
 writeFileSync(ev+'remote-migration-receipt.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){console.log(JSON.stringify({status:'REMOTE_MIGRATION_BLOCKED',reason:/^[A-Z_]+$/.test(error.message)?error.message:'REMOTE_OPERATION_FAILED',committed}));process.exitCode=2;}
finally{await client?.end().catch(()=>{});if(passFile&&existsSync(passFile))unlinkSync(passFile);}

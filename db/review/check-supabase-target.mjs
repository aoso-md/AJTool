// READ ONLY. Never applies migrations, grants or reads study payloads.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {databaseTransport} from '../../tools/calculate-cpk-ppk/src/platform/postgres-transport.js';
import {validateRuntime,MIGRATIONS} from '../../tools/calculate-cpk-ppk/src/platform/postgres-contract.js';
const {Pool}=createRequire(new URL('../../tools/calculate-cpk-ppk/package.json',import.meta.url))('pg');
export const PROJECT_REF='lcteryhtsynrxgfpvryt';
export const TABLES=['consumer_cursors','delivery_gates','event_inbox','event_outbox','event_rejections','manual_commands','outbox_attempts','runtime_identity','schema_migrations','settings','settings_history','spec_cache','studies'];
export function targetDescriptor(value){
 let u;try{u=new URL(value);}catch{throw new Error('invalid_database_url');}
 if(!['postgres:','postgresql:'].includes(u.protocol))throw new Error('invalid_database_protocol');
 if([...u.searchParams.keys()].some(k=>['host','hostname','hostaddr','port','user','username','database','dbname','password','service','servicefile'].includes(k.toLowerCase())))throw new Error('connection_target_overrides_not_allowed');
 if(u.hostname===`db.${PROJECT_REF}.supabase.co`&&(!u.port||u.port==='5432'))return {projectRef:PROJECT_REF,mode:'direct'};
 if(u.hostname.endsWith('.pooler.supabase.com')&&decodeURIComponent(u.username).endsWith('.'+PROJECT_REF)){
  if(u.port!=='5432')throw new Error('session_pooler_port_5432_required');
  return {projectRef:PROJECT_REF,mode:'session'};
 }
 throw new Error('unapproved_database_target');
}
export async function inspectCatalog(pool){
 const client=await pool.connect();let metadata;
 try{
  await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='3000ms'");
  const version=(await client.query("SELECT current_setting('server_version_num')::int AS number,current_setting('server_version') AS version,current_user AS role")).rows[0];
  const ssl=(await client.query('SELECT ssl,version,bits FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
  const present=(await client.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1)",[TABLES])).rows.map(x=>x.relname);
  const foreign=(await client.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND NOT c.relname=ANY($1)",[TABLES])).rows[0].n;
  const versions=present.includes('schema_migrations')?(await client.query('SELECT version,checksum FROM public.schema_migrations ORDER BY version')).rows:[];
  const outside=(await client.query("SELECT n.nspname AS schema,c.relname AS object FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema','public') AND c.relkind IN ('r','p','v','m','f') AND has_schema_privilege(n.oid,'USAGE') AND (has_table_privilege(c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))")).rows;
  const apiRoles=(await client.query("SELECT r.rolname,count(c.oid) FILTER(WHERE has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))::int AS accessible_tables FROM pg_roles r LEFT JOIN (pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public') ON c.relkind='r' AND c.relname=ANY($1) WHERE r.rolname IN ('anon','authenticated','service_role') GROUP BY r.rolname",[TABLES])).rows;
  metadata={serverVersion:version.version,postgresMajor:Math.floor(version.number/10000),role:version.role,clientTlsVerified:client.connection?.stream?.encrypted===true&&client.connection?.stream?.authorized===true,backendTls:ssl?.ssl??null,tlsProtocol:ssl?.version??null,missingTables:TABLES.filter(t=>!present.includes(t)),otherPublicObjects:foreign,migrationsMatch:versions.length===3&&versions.every(v=>MIGRATIONS[v.version]===v.checksum),dataApiRoles:apiRoles};
  metadata.outsideApplicationObjects=outside;
  await client.query('COMMIT');
 }catch{await client.query('ROLLBACK').catch(()=>{});throw new Error('catalog_inspection_failed');}finally{client.release();}
 try{await validateRuntime(pool);metadata.runtimeContractValid=true;}catch{metadata.runtimeContractValid=false;}
  metadata.findings=[];
 if(metadata.outsideApplicationObjects.length)metadata.findings.push('provider_or_other_schema_runtime_access_requires_administrator_review');
 if(metadata.missingTables.length)metadata.findings.push('migrations_or_tables_missing');
 if(!metadata.migrationsMatch)metadata.findings.push('migration_checksums_not_validated');
 if(!metadata.runtimeContractValid)metadata.findings.push('runtime_schema_or_role_not_accepted');
 if(metadata.otherPublicObjects)metadata.findings.push('shared_public_schema_requires_scoped_administrator_review');
 if(metadata.dataApiRoles.some(x=>x.accessible_tables>0))metadata.findings.push('supabase_data_api_roles_have_table_access');
 metadata.backupRestore='NOT_TESTED';metadata.durableWriteRecovery='NOT_TESTED';
 return metadata;
}
async function main(){
 const value=process.env.AJTOOL_TARGET_DATABASE_URL;
 if(!value){console.log(JSON.stringify({status:'NOT_TESTED',projectRef:PROJECT_REF,reason:'authorized_connection_not_available',mutations:false,payloadsRead:false}));process.exitCode=2;return;}
 let pool;
 try{
  const target=targetDescriptor(value);pool=new Pool({...databaseTransport(value),max:1,connectionTimeoutMillis:5000,query_timeout:5000});pool.on('error',()=>{});
  const report=await inspectCatalog(pool);if(!report.clientTlsVerified)report.findings.push('verified_client_tls_required');
  console.log(JSON.stringify({status:report.findings.length?'REVIEW_REQUIRED':'CONNECTION_SCHEMA_ROLE_PASS',target,...report,mutations:false,payloadsRead:false},null,2));
  if(report.findings.length)process.exitCode=2;
 }catch{console.log(JSON.stringify({status:'NOT_CERTIFIED',reason:'target_or_connection_or_catalog_rejected',mutations:false,payloadsRead:false}));process.exitCode=2;}finally{if(pool)await pool.end();}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await main();

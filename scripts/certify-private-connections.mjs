import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {targetDescriptor,inspectCatalog} from '../db/review/check-supabase-target.mjs';
const {Pool}=createRequire(new URL('../tools/calculate-cpk-ppk/package.json',import.meta.url))('pg');
const root=fileURLToPath(new URL('../',import.meta.url)),out=root+'artifacts/final-execution-20261101/';mkdirSync(out,{recursive:true});
let pools=[];
try{
 const urls={migrator:new URL(process.env.AJTOOL_MIGRATOR_DATABASE_URL||''),runtime:new URL(process.env.AJTOOL_TARGET_DATABASE_URL||'')};
 if(decodeURIComponent(urls.migrator.password)===decodeURIComponent(urls.runtime.password))throw new Error('CREDENTIALS_NOT_INDEPENDENT');
 const ca=readFileSync(root+'db/review/certs/supabase-prod-ca-2021.crt');if(createHash('sha256').update(ca).digest('hex')!=='700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7')throw new Error('CA_CHANGED');
 const report={atUtc:new Date().toISOString(),projectRef:'lcteryhtsynrxgfpvryt',independentCredentials:true,connections:{},passwordsChanged:false};
 for(const [kind,u] of Object.entries(urls)){
  targetDescriptor(u.toString());const role=kind==='runtime'?'ajtool_service':'postgres';if(decodeURIComponent(u.username)!==role+'.lcteryhtsynrxgfpvryt'||u.pathname!=='/postgres')throw new Error('WRONG_ROLE_OR_DATABASE');
  for(const key of [...u.searchParams.keys()])if(key.toLowerCase().startsWith('ssl'))u.searchParams.delete(key);
  const pool=new Pool({connectionString:u.toString(),ssl:{ca,rejectUnauthorized:true,servername:u.hostname},max:1,connectionTimeoutMillis:10000,query_timeout:15000});pool.on('error',()=>{});pools.push(pool);
  const c=await pool.connect();let identity;
  try{identity=(await c.query('SELECT current_user,current_database()')).rows[0];if(!c.connection.stream.encrypted||!c.connection.stream.authorized)throw new Error('TLS_NOT_VERIFIED');report.connections[kind]={role:identity.current_user,database:identity.current_database,tlsVerified:true,tlsProtocol:c.connection.stream.getProtocol()};}finally{c.release();}
  if(kind==='runtime'){
   const catalog=await inspectCatalog(pool);if(catalog.findings.length)throw new Error('RUNTIME_CONTRACT_FAILED');
   report.connections.runtime.runtimeContractCertified=true;report.connections.runtime.apiRolesDenied=catalog.dataApiRoles.every(r=>r.accessible_tables===0);report.connections.runtime.pgStatSslBackendReported=catalog.backendTls;
  }else report.adminSessions=(await pool.query("SELECT usename,count(*)::int AS connections FROM pg_stat_activity WHERE datname=current_database() AND usename='postgres' AND pid<>pg_backend_pid() GROUP BY usename")).rows;
 }
 report.status='BOTH_PRIVATE_CONNECTIONS_CERTIFIED';writeFileSync(out+'connections.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){console.log(JSON.stringify({status:'CONNECTION_VERIFICATION_FAILED',reason:/^[A-Z_]+$/.test(error.message)?error.message:'PRIVATE_CONNECTION_CHECK_FAILED'}));process.exitCode=2;}
finally{await Promise.all(pools.map(p=>p.end().catch(()=>{})));}

// One-shot authentication only. Password arrives over an anonymous stdin pipe.
import {createRequire} from 'node:module';
import {checkServerIdentity} from 'node:tls';
import {connect as connectTls} from 'node:tls';
import {connect as connectTcp} from 'node:net';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {X509Certificate,createHash} from 'node:crypto';
import {savePrivate} from './sql-private-config.mjs';
import {scramVerifier} from './runtime-secret.mjs';
import {fileURLToPath} from 'node:url';
import {targetDescriptor} from '../db/review/check-supabase-target.mjs';
import {validateRuntime} from '../tools/calculate-cpk-ppk/src/platform/postgres-contract.js';
const require=createRequire(new URL('../tools/calculate-cpk-ppk/package.json',import.meta.url));
const {Client}=require('pg');
const host='aws-1-us-west-2.pooler.supabase.com';
const projectRef='lcteryhtsynrxgfpvryt';
// Public CA downloaded from the authenticated project's Database / SSL page.
// Scope is this one-off client only; no OS trust store or runtime settings change.
const officialCa=readFileSync(new URL('../db/review/certs/supabase-prod-ca-2021.crt',import.meta.url));
if(!new X509Certificate(officialCa).ca)throw new Error('Official CA file invalid');
const caSha256=createHash('sha256').update(officialCa).digest('hex');
if(caSha256!=='700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7')throw new Error('Official CA fingerprint changed; review required');
const strictTls={ca:officialCa,rejectUnauthorized:true,servername:host,checkServerIdentity:(_,cert)=>checkServerIdentity(host,cert)};
// PostgreSQL SSLRequest only. No startup/authentication packet, password or SQL.
if(process.argv.includes('--tls-only')){
  let tcp,tls;
  const result={mode:'TLS_ONLY',host,port:5432,passwordSent:false,sqlExecuted:false,caSha256,systemCa:process.execArgv.includes('--use-system-ca'),tlsVerified:false};
  try{
    if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Object.assign(new Error(),{code:'UNSAFE_TLS_ENVIRONMENT'});
    await new Promise((resolve,reject)=>{
      tcp=connectTcp({host,port:5432});tcp.setTimeout(10000,()=>tcp.destroy(Object.assign(new Error(),{code:'ETIMEDOUT'})));tcp.on('error',reject);
      tcp.once('connect',()=>{const request=Buffer.alloc(8);request.writeInt32BE(8,0);request.writeInt32BE(80877103,4);tcp.write(request);});
      tcp.once('data',data=>{
        if(data.length!==1||data[0]!==83){reject(Object.assign(new Error(),{code:'TLS_UNAVAILABLE'}));return;}
        tls=connectTls({socket:tcp,...strictTls});
        tls.on('error',reject);tls.once('secureConnect',()=>{result.tlsVerified=tls.authorized;result.tlsProtocol=tls.getProtocol();resolve();});
      });
    });
    result.status=result.tlsVerified?'TLS_VERIFIED':'ERROR DE CONECTIVIDAD';
  }catch(error){result.status='ERROR DE CONECTIVIDAD';const code=String(error?.code??'UNKNOWN');result.reason=/^[A-Z0-9_]{1,60}$/.test(code)?code:'TLS_NOT_CONFIRMED';process.exitCode=2;}
  finally{tls?.destroy();tcp?.destroy();}
  console.log(JSON.stringify(result,null,2));
  process.exit(process.exitCode??0);
}
const report={status:'REQUIERE INTERVENCIÓN',atUtc:new Date().toISOString(),projectRef,mode:'session',host,port:5432,query:'SELECT current_user, current_database()',caSha256,tlsVerified:false,mutations:false,passwordSaved:false};
const sqlRole=process.argv.includes('--runtime')?'ajtool_service':'postgres';
let client,password,raw;
try{
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;if(size>16384)throw Object.assign(new Error(),{code:'INPUT_TOO_LONG'});chunks.push(chunk);}
  raw=Buffer.concat(chunks);for(const chunk of chunks)chunk.fill(0);
  password=raw.toString('utf8');raw.fill(0);
  if(process.argv.includes('--pipe-self-test')){
    // Public fixture exercises the real Windows launcher without any SQL traffic.
    const matches=password==='AJTool-pipe-\u00f1\u20ac-test';
    password=undefined;
    console.log(matches?'PIPE_SELF_TEST_PASS':'PIPE_SELF_TEST_FAIL');
    process.exit(matches?0:2);
  }
  if(!password)throw Object.assign(new Error(),{code:'PASSWORD_REQUIRED'});
  if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Object.assign(new Error(),{code:'UNSAFE_TLS_ENVIRONMENT'});
  if(process.argv.includes('--establish-runtime')){
    if(sqlRole!=='ajtool_service'||!process.argv.includes('--save-private'))throw Object.assign(new Error(),{code:'INVALID_RUNTIME_PROVISIONING_MODE'});
    process.loadEnvFile(fileURLToPath(new URL('../.env.ajtool-supabase/connection.env',import.meta.url)));
    if(process.env.AJTOOL_TARGET_DATABASE_URL)throw Object.assign(new Error(),{code:'RUNTIME_ALREADY_CONFIGURED'});
    const adminUrl=new URL(process.env.AJTOOL_MIGRATOR_DATABASE_URL||'');targetDescriptor(adminUrl.toString());
    if(adminUrl.hostname!==host||decodeURIComponent(adminUrl.username)!=='postgres.'+projectRef||adminUrl.pathname!=='/postgres')throw Object.assign(new Error(),{code:'WRONG_ADMINISTRATIVE_TARGET'});
    if(password===decodeURIComponent(adminUrl.password))throw Object.assign(new Error(),{code:'RUNTIME_MUST_USE_INDEPENDENT_PASSWORD'});
    const verifier=scramVerifier(password);
    for(const key of [...adminUrl.searchParams.keys()])if(key.toLowerCase().startsWith('ssl'))adminUrl.searchParams.delete(key);
    const admin=new Client({connectionString:adminUrl.toString(),ssl:strictTls,connectionTimeoutMillis:10000,query_timeout:5000,application_name:'ajtool-runtime-credential-provisioning'});
    try{
      await admin.connect();if(!admin.connection.stream.authorized)throw Object.assign(new Error(),{code:'TLS_NOT_VERIFIED'});
      const flags=(await admin.query("SELECT rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS safe FROM pg_roles WHERE rolname='ajtool_service'")).rows[0];
      if(!flags?.safe)throw Object.assign(new Error(),{code:'RUNTIME_ROLE_REQUIRES_REVIEW'});
      const sessions=(await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename='ajtool_service'")).rows[0].n;
      if(sessions!==0)throw Object.assign(new Error(),{code:'ACTIVE_RUNTIME_CONNECTIONS_PRESERVED'});
      // Like psql \password: send a SCRAM verifier, never a plaintext SQL literal.
      await admin.query("ALTER ROLE ajtool_service PASSWORD '"+verifier+"'");
      report.runtimePasswordEstablished=true;report.mutations=true;report.passwordMethod='SCRAM-SHA-256';
    }finally{await admin.end().catch(()=>{});}
  }
  client=new Client({host,port:5432,database:'postgres',user:`${sqlRole}.${projectRef}`,password,
    ssl:strictTls,
    connectionTimeoutMillis:10000,query_timeout:5000,application_name:'ajtool-auth-readonly-check'});
  client.on('error',()=>{});
  await client.connect();
  const stream=client.connection.stream;
  if(!stream.encrypted||!stream.authorized)throw Object.assign(new Error(),{code:'TLS_NOT_VERIFIED'});
  report.tlsVerified=true;report.tlsProtocol=stream.getProtocol();
  const {rows}=await client.query(report.query);
  if(rows.length!==1||rows[0].current_user!==sqlRole||rows[0].current_database!=='postgres')throw Object.assign(new Error(),{code:'UNEXPECTED_IDENTITY'});
  report.currentUser=rows[0].current_user;report.currentDatabase=rows[0].current_database;
  report.authenticationSucceeded=true;
  report.status='AUTENTICACIÓN CORRECTA';
  if(process.argv.includes('--save-private')){
    // Metadata only. Activity cannot discover dormant clients or prove a zero-downtime rotation.
    const result=await client.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,has_database_privilege(oid,current_database(),'TEMP') AS database_temp FROM pg_roles WHERE rolname IN ('postgres','ajtool_service') ORDER BY rolname");
    report.roleMetadata=result.rows;
    if(sqlRole==='postgres'){
      const activity=await client.query("SELECT usename,count(*)::int AS sessions,count(DISTINCT application_name)::int AS application_count FROM pg_stat_activity WHERE datname=current_database() AND usename IN ('postgres','ajtool_service') AND pid<>pg_backend_pid() GROUP BY usename ORDER BY usename");
      report.activeConnections=activity.rows;report.consumerInventoryComplete=false;
    }else{
      const role=result.rows.find(r=>r.rolname===sqlRole);
      report.runtimeRoleFlagsSafe=!!role&&!['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','database_temp'].some(k=>role[k]);
      report.runtimeContractCertified=false;
      if(!report.runtimeRoleFlagsSafe)throw Object.assign(new Error(),{code:'RUNTIME_PRIVILEGE_REVIEW_REQUIRED'});
      const {Pool}=require('pg');const pool=new Pool({host,port:5432,database:'postgres',user:`ajtool_service.${projectRef}`,password,ssl:strictTls,max:1,connectionTimeoutMillis:10000,query_timeout:5000});
      try{await validateRuntime(pool);report.runtimeContractCertified=true;}finally{await pool.end();}
    }
    report.savedVariable=savePrivate(sqlRole,password);report.passwordSaved=true;
    report.rotationCompletedReportedByOperator=process.argv.includes('--rotation-completed');
    report.productionUseCertified=false;
  }
}catch(error){
  // Never emit driver messages/stacks: they can contain credentials or URIs.
  const code=String(error?.code??'UNKNOWN');
  report.status=code==='28P01'?'CONTRASEÑA RECHAZADA':['PASSWORD_REQUIRED','INPUT_TOO_LONG','UNSAFE_TLS_ENVIRONMENT','UNEXPECTED_IDENTITY','WRONG_ADMINISTRATIVE_TARGET','INVALID_RUNTIME_PROVISIONING_MODE','ACTIVE_RUNTIME_CONNECTIONS_PRESERVED'].includes(code)||code.startsWith('RUNTIME_')||report.authenticationSucceeded?'REQUIERE INTERVENCIÓN':'ERROR DE CONECTIVIDAD';
  report.reason=/^[A-Z0-9_]{1,60}$/.test(code)?code:'CONNECTION_NOT_CONFIRMED';
  process.exitCode=2;
}finally{
  password=undefined;if(raw)raw.fill(0);
  if(client){client.password=undefined;await client.end().catch(()=>{});}
}
const folder=new URL('../artifacts/sql-auth-20261101/',import.meta.url);
try{mkdirSync(folder,{recursive:true});writeFileSync(new URL(`auth-${Date.now()}.json`,folder),JSON.stringify(report,null,2)+'\n',{flag:'wx'});}catch{report.receiptSaved=false;}
console.log(JSON.stringify(report,null,2));

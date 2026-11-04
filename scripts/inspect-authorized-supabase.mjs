// Authorized metadata only; never emits a connection URI or study document.
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {targetDescriptor} from '../db/review/check-supabase-target.mjs';
const {Client}=createRequire(new URL('../tools/calculate-cpk-ppk/package.json',import.meta.url))('pg');
const evidence=new URL('../artifacts/real-postgres-20261101/',import.meta.url);
mkdirSync(evidence,{recursive:true});
let client;
try{
 const raw=process.env.AJTOOL_MIGRATOR_DATABASE_URL;if(!raw)throw Object.assign(new Error(),{code:'MIGRATOR_NOT_CONFIGURED'});
 const target=targetDescriptor(raw),u=new URL(raw);
 if(decodeURIComponent(u.username)!=='postgres.lcteryhtsynrxgfpvryt'||u.pathname!=='/postgres'||target.mode!=='session')throw Object.assign(new Error(),{code:'WRONG_IDENTITY_OR_TARGET'});
 for(const k of [...u.searchParams.keys()])if(k.toLowerCase().startsWith('ssl'))u.searchParams.delete(k);
 const ca=readFileSync(new URL('../db/review/certs/supabase-prod-ca-2021.crt',import.meta.url));
 if(createHash('sha256').update(ca).digest('hex')!=='700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7')throw Object.assign(new Error(),{code:'CA_CHANGED'});
 client=new Client({connectionString:u.toString(),ssl:{ca,rejectUnauthorized:true,servername:u.hostname},connectionTimeoutMillis:10000,query_timeout:20000,application_name:'ajtool-authorized-backup-preflight'});client.on('error',()=>{});
 await client.connect();
 if(!client.connection.stream.authorized||!client.connection.stream.encrypted)throw Object.assign(new Error(),{code:'TLS_NOT_VERIFIED'});
 await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='15000ms'");
 const sql=readFileSync(new URL('../db/review/supabase-inventory.sql',import.meta.url),'utf8').replace(/^BEGIN READ ONLY;\s*SET LOCAL statement_timeout = '15000ms';\s*/,'').replace(/\s*COMMIT;\s*$/,'');
 const result=(await client.query(sql)).rows[0].ajtool_readonly_inventory;
 const dependencies=(await client.query("SELECT usename,count(*)::int AS sessions,count(DISTINCT application_name)::int AS applications FROM pg_stat_activity WHERE datname=current_database() AND usename IN ('postgres','ajtool_service') AND pid<>pg_backend_pid() GROUP BY usename ORDER BY usename")).rows;
 await client.query('COMMIT');
 const report={atUtc:new Date().toISOString(),projectRef:target.projectRef,tlsVerified:true,tlsProtocol:client.connection.stream.getProtocol(),scope:'read-only metadata/counts/fingerprints; no payload export',catalog:result,dependencies};
 const destination=existsSync(new URL('catalog-before.json',evidence))?'catalog-check-'+Date.now()+'.json':'catalog-before.json';
 writeFileSync(new URL(destination,evidence),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:'MIGRATOR_CONNECTION_VERIFIED',projectRef:target.projectRef,tlsVerified:true,serverVersion:result.server_version,role:result.catalog_role,database:result.database,counts:result.counts,dependencies,remoteMutations:false}));
}catch(error){const code=String(error?.code??'READONLY_INSPECTION_FAILED');console.log(JSON.stringify({status:'BLOCKED',reason:/^[A-Z0-9_]{1,60}$/.test(code)?code:'READONLY_INSPECTION_FAILED',remoteMutations:false}));process.exitCode=2;}
finally{await client?.end().catch(()=>{});}

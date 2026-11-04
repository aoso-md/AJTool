import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {scramVerifier} from './runtime-secret.mjs';
const {Client}=createRequire(new URL('../tools/calculate-cpk-ppk/package.json',import.meta.url))('pg');
const ownerUrl=new URL(process.env.AJTOOL_RESTORE_DATABASE_URL||'');assert.equal(ownerUrl.hostname,'127.0.0.1');assert.equal(ownerUrl.pathname,'/ajtool_restored');
const owner=new Client({connectionString:ownerUrl.toString(),ssl:false});let probe,created=false;
try{
 assert.throws(()=>scramVerifier('short'));assert.throws(()=>scramVerifier('password with spaces that is long enough'));
 const password=randomBytes(24).toString('hex'),verifier=scramVerifier(password);
 assert.match(verifier,/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
 await owner.connect();await owner.query("CREATE ROLE ajtool_scram_probe LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '"+verifier+"'");created=true;
 const probeUrl=new URL(ownerUrl);probeUrl.username='ajtool_scram_probe';probeUrl.password=password;probe=new Client({connectionString:probeUrl.toString(),ssl:false});await probe.connect();assert.equal((await probe.query('SELECT current_user')).rows[0].current_user,'ajtool_scram_probe');await probe.end();probe=undefined;
 const report={status:'SCRAM_PROVISIONING_LOCAL_PASS',actualPostgresAuthentication:true,noPlaintextPasswordInSql:true,shortPasswordRejected:true,spacesRejected:true,remoteCredentialChanged:false};
 writeFileSync(new URL('../artifacts/real-postgres-20261101/runtime-secret-procedure-test.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch{console.log(JSON.stringify({status:'SCRAM_PROVISIONING_LOCAL_FAILED',remoteCredentialChanged:false}));process.exitCode=2;}
finally{await probe?.end().catch(()=>{});if(created)await owner.query('DROP ROLE ajtool_scram_probe').catch(()=>{});await owner.end().catch(()=>{});}

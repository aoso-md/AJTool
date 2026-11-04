// Real remote read-only pg_dump; private data never reaches logs or tracked files.
import {readFileSync,writeFileSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {targetDescriptor} from '../db/review/check-supabase-target.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const privateDir=fileURLToPath(new URL('../.env.ajtool-supabase/',import.meta.url));
const evidence=new URL('../artifacts/real-postgres-20261101/',import.meta.url);
const python='C:/Users/aabaro/AppData/Local/Programs/Python/Python312/python.exe';
const sha=data=>createHash('sha256').update(data).digest('hex');
const safeRun=(program,args,options={})=>{const r=spawnSync(program,args,{cwd:root,windowsHide:true,timeout:120000,maxBuffer:100*1024*1024,...options});if(r.status!==0)throw new Error('COMMAND_FAILED');return r.stdout;};
let passFile;
try{
 const u=new URL(process.env.AJTOOL_MIGRATOR_DATABASE_URL||'');const target=targetDescriptor(u.toString());
 if(target.mode!=='session'||decodeURIComponent(u.username)!=='postgres.lcteryhtsynrxgfpvryt'||u.pathname!=='/postgres')throw new Error('WRONG_TARGET');
 if(safeRun('git',['check-ignore','-q',privateDir+'backup.dpapi']).length)throw new Error('PRIVATE_PATH_REQUIRED');
 mkdirSync(evidence,{recursive:true});
 const id=new Date().toISOString().replace(/[:.]/g,'-');
 const backup=privateDir+`ajtool-public-${id}.dump.dpapi`;
 passFile=privateDir+`backup-pass-${randomBytes(6).toString('hex')}`;
 const esc=s=>s.replace(/\\/g,'\\\\').replace(/:/g,'\\:');
 writeFileSync(passFile,[u.hostname,'5432','postgres',decodeURIComponent(u.username),decodeURIComponent(u.password)].map(esc).join(':')+'\n',{flag:'wx',mode:0o600});
 // Password read from private mount, copied to container tmpfs with mode0600.
 const containerName='ajtool-readonly-dump-'+randomBytes(6).toString('hex');
 const command='umask 077; cp /private-pass /tmp/pgpass; export PGPASSFILE=/tmp/pgpass; export PGSSLMODE=verify-full; export PGSSLROOTCERT=/official-ca; exec pg_dump --no-password --host=aws-1-us-west-2.pooler.supabase.com --port=5432 --username=postgres.lcteryhtsynrxgfpvryt --dbname=postgres --schema=public --format=custom --lock-wait-timeout=10000';
 const dump=safeRun('docker',['run','--rm','--name',containerName,'--label','ajtool.readonly-backup=true','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=16m','--mount',`type=bind,source=${passFile},target=/private-pass,readonly`,'--mount',`type=bind,source=${root}db/review/certs/supabase-prod-ca-2021.crt,target=/official-ca,readonly`,'postgres:17','sh','-c',command]);
 if(dump.subarray(0,5).toString()!=='PGDMP')throw new Error('NOT_CUSTOM_ARCHIVE');
 const sealed=safeRun(python,['-X','utf8','scripts/private-backup-crypto.py','encrypt'],{input:dump});
 writeFileSync(backup,sealed,{flag:'wx',mode:0o600});
 const recovered=safeRun(python,['-X','utf8','scripts/private-backup-crypto.py','decrypt'],{input:readFileSync(backup)});
 if(!dump.equals(recovered))throw new Error('BACKUP_ROUNDTRIP_FAILED');
 const report={status:'REAL_BACKUP_ENCRYPTED_VERIFIED',atUtc:new Date().toISOString(),projectRef:target.projectRef,scope:'all AJTool public schema data/DDL/ACL/policies; excludes provider auth/storage and Railway RAM',format:'pg_dump custom',backupPrivateFile:backup.slice(privateDir.length),dumpSha256:sha(dump),encryptedSha256:sha(sealed),bytes:dump.length,localDecryptByteExact:true,custody:'DPAPI CurrentUser Windows profile/keys; cross-machine disaster recovery NOT proven',restoreVerified:false,remoteMutations:false};
 writeFileSync(new URL('backup-receipt.json',evidence),JSON.stringify(report,null,2)+'\n');
 dump.fill(0);recovered.fill(0);console.log(JSON.stringify(report));
}catch(error){console.log(JSON.stringify({status:'BACKUP_BLOCKED',reason:['WRONG_TARGET','NOT_CUSTOM_ARCHIVE','BACKUP_ROUNDTRIP_FAILED','PRIVATE_PATH_REQUIRED'].includes(error.message)?error.message:'BACKUP_COMMAND_FAILED',remoteMutations:false}));process.exitCode=2;}
finally{if(passFile&&existsSync(passFile))unlinkSync(passFile);}

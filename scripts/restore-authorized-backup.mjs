// Restore only into a newly created, labelled loopback-only local container.
import {readFileSync,writeFileSync,existsSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {Client}=createRequire(new URL('../tools/calculate-cpk-ppk/package.json',import.meta.url))('pg');
const root=fileURLToPath(new URL('../',import.meta.url)),priv=root+'.env.ajtool-supabase/';
const evidence=root+'artifacts/real-postgres-20261101/';
const name='ajtool-real-restore-20261101',database='ajtool_restored';
const sha=x=>createHash('sha256').update(x).digest('hex');
const run=(args,input)=>{const r=spawnSync('docker',args,{input,windowsHide:true,timeout:120000,maxBuffer:100*1024*1024});if(r.status!==0){const category=r.stderr?.toString().match(/ERROR: (role .*? does not exist|permission denied[^\r\n]*|schema .*? does not exist)/)?.[1];throw Object.assign(new Error('LOCAL_COMMAND_FAILED'),{category:category?'RESTORE_ROLE_OR_SCHEMA_PERMISSION':'LOCAL_COMMAND_FAILED'});}return r.stdout;};
const sql=(text,db=database)=>run(['exec','-i',name,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],Buffer.from(text));
let client,envPath;
try{
 if(existsSync(priv+'restore.env'))throw new Error('RESTORE_ALREADY_PREPARED');
 const prior=spawnSync('docker',['container','inspect',name],{windowsHide:true});if(prior.status===0)throw new Error('LOCAL_NAME_ALREADY_EXISTS');
 const receipt=JSON.parse(readFileSync(evidence+'backup-receipt.json','utf8'));
 if(!/^ajtool-public-[\w.-]+\.dump\.dpapi$/.test(receipt.backupPrivateFile))throw new Error('INVALID_BACKUP_PATH');
 const encrypted=readFileSync(priv+receipt.backupPrivateFile);if(sha(encrypted)!==receipt.encryptedSha256)throw new Error('BACKUP_HASH_MISMATCH');
 const decrypt=spawnSync('C:/Users/aabaro/AppData/Local/Programs/Python/Python312/python.exe',['-X','utf8',root+'scripts/private-backup-crypto.py','decrypt'],{input:encrypted,windowsHide:true,maxBuffer:100*1024*1024});
 if(decrypt.status!==0||sha(decrypt.stdout)!==receipt.dumpSha256)throw new Error('DECRYPT_HASH_MISMATCH');
 const password=randomBytes(24).toString('hex');envPath=priv+'restore-container.env';writeFileSync(envPath,'POSTGRES_PASSWORD='+password+'\n',{flag:'wx',mode:0o600});
 run(['run','-d','--name',name,'--label','ajtool.real-restore=true','--label','ajtool.project=lcteryhtsynrxgfpvryt','--env-file',envPath,'-p','127.0.0.1::5432','postgres:17']);
 unlinkSync(envPath);envPath=undefined;
 let ready=false;for(let i=0;i<40;i++){const r=spawnSync('docker',['exec',name,'pg_isready','-U','postgres'],{windowsHide:true});if(r.status===0){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,500));}if(!ready)throw new Error('LOCAL_DATABASE_NOT_READY');
 sql('CREATE DATABASE '+database+';', 'postgres');
 sql("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE ROLE authenticator NOLOGIN; CREATE ROLE supabase_admin NOLOGIN; CREATE ROLE ajtool_service NOLOGIN;");
 // Newly created isolated DB only: replace its empty default public schema.
 run(['exec','-i',name,'pg_restore','--clean','--if-exists','--exit-on-error','-U','postgres','-d',database],decrypt.stdout);decrypt.stdout.fill(0);
 const port=JSON.parse(run(['inspect','--format','{{json .NetworkSettings.Ports}}',name]).toString())['5432/tcp'][0];
 if(port.HostIp!=='127.0.0.1')throw new Error('LOCAL_BIND_NOT_PRIVATE');
 client=new Client({host:'127.0.0.1',port:Number(port.HostPort),user:'postgres',password,database,ssl:false});await client.connect();
 const inventory=readFileSync(root+'db/review/supabase-inventory.sql','utf8').replace(/^BEGIN READ ONLY;\s*SET LOCAL statement_timeout = '15000ms';\s*/,'').replace(/\s*COMMIT;\s*$/,'');
 const catalog=(await client.query(inventory)).rows[0].ajtool_readonly_inventory;
 const source=JSON.parse(readFileSync(evidence+'catalog-before.json','utf8')).catalog;
 const fields=['tables','columns','constraints','indexes','policies','triggers','functions','counts','historical_checks'];
 const comparisons=Object.fromEntries(fields.map(k=>[k,JSON.stringify(catalog[k])===JSON.stringify(source[k])]));
 const sequence=(await client.query('SELECT last_value,is_called FROM public.settings_history_id_seq')).rows[0];
 // Private local URL retained for operations; never console output.
 writeFileSync(priv+'restore.env',`AJTOOL_RESTORE_DATABASE_URL=postgresql://postgres:${password}@127.0.0.1:${port.HostPort}/${database}\nAJTOOL_RESTORE_CONTAINER=${name}\n`,{flag:'wx',mode:0o600});
 writeFileSync(evidence+'catalog-restored.json',JSON.stringify({scope:'actual backup restored locally only',catalog},null,2)+'\n');
 const report={status:Object.values(comparisons).every(Boolean)?'REAL_RESTORE_COMPARISON_PASS':'REAL_RESTORE_REVIEW_REQUIRED',container:name,port:Number(port.HostPort),scope:'local isolated restored AJTool public data, schema, ACL and RLS',comparisons,sequence,counts:catalog.counts,backupSha256:receipt.dumpSha256,sourceModified:false,remoteMutations:false,portableDisasterRecoveryVerified:false};
 writeFileSync(evidence+'restore-receipt.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){console.log(JSON.stringify({status:'RESTORE_BLOCKED',reason:/^[A-Z_]+$/.test(error.message)?error.message:'LOCAL_RESTORE_FAILED',remoteMutations:false}));process.exitCode=2;}
finally{await client?.end().catch(()=>{});if(envPath&&existsSync(envPath))unlinkSync(envPath);}

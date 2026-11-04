import {readFileSync,writeFileSync,renameSync,lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
export function connectionFor(role,password){
  if(!['postgres','ajtool_service'].includes(role)||!password)throw new Error('invalid_role_or_password');
  const url=new URL('postgresql://aws-1-us-west-2.pooler.supabase.com:5432/postgres');
  url.username=role+'.lcteryhtsynrxgfpvryt';url.password=encodeURIComponent(password);
  url.searchParams.set('sslmode','verify-full');
  url.searchParams.set('sslrootcert',fileURLToPath(new URL('../db/review/certs/supabase-prod-ca-2021.crt',import.meta.url)));
  return url.toString();
}
export function mergePrivateConfig(content,key,value){
  if(!['AJTOOL_MIGRATOR_DATABASE_URL','AJTOOL_TARGET_DATABASE_URL'].includes(key))throw new Error('invalid_key');
  const lines=content.split(/\r?\n/);let count=0;
  const result=lines.map(line=>{
    if(!new RegExp('^\\s*'+key+'\\s*=').test(line))return line;
    count++;const prior=line.slice(line.indexOf('=')+1).trim();
    if(prior&&!['""',"''"].includes(prior))throw new Error('existing_credential_not_overwritten');
    return key+'='+value;
  });
  if(count>1)throw new Error('duplicate_key');
  if(!count)result.push(key+'='+value);
  return result.join('\n');
}
export function savePrivate(role,password){
  const root=fileURLToPath(new URL('../',import.meta.url));
  const file=fileURLToPath(new URL('../.env.ajtool-supabase/connection.env',import.meta.url));
  if(lstatSync(file).isSymbolicLink())throw new Error('symlink_refused');
  const check=spawnSync('git',['check-ignore','--quiet','--',file],{cwd:root,windowsHide:true});
  if(check.status!==0)throw new Error('private_file_not_gitignored');
  const key=role==='postgres'?'AJTOOL_MIGRATOR_DATABASE_URL':'AJTOOL_TARGET_DATABASE_URL';
  const merged=mergePrivateConfig(readFileSync(file,'utf8').replace(/^\uFEFF/,''),key,connectionFor(role,password));
  const temporary=file+'.pending';
  try{writeFileSync(temporary,merged,{flag:'wx',mode:0o600});renameSync(temporary,file);}catch(error){
    // Do not remove a pre-existing pending file belonging to another operation.
    throw new Error('private_config_write_failed');
  }
  return key;
}

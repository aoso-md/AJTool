// Optional open-mode LOCAL demonstration. No ORCA URL or credential is read.
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=root+'.env.carlos-local';
if(existsSync(directory))throw new Error('Local directory exists. Reuse it; refusing to rotate credentials or overwrite persistent data.');
mkdirSync(directory,{mode:0o700});
const secret=()=>randomBytes(32).toString('hex');
const save=(name,value)=>writeFileSync(`${directory}/${name}`,value,{mode:0o600});
save('postgres.env',`POSTGRES_USER=ajtool_carlos_local_admin\nPOSTGRES_PASSWORD=${secret()}\nPOSTGRES_DB=ajtool_carlos_local_admin\n`);
let bootstrap='\\set ON_ERROR_STOP on\n';
for(const tag of ['cpk','msa']){
  const owner=`ajtool_${tag}_owner`,runtime=`ajtool_${tag}_runtime`,db=`ajtool_${tag}`;
  const ownerPassword=secret(),runtimePassword=secret();
  const example=readFileSync(new URL(`./${tag}.env.example`,import.meta.url),'utf8');
  save(`${tag}.env`,example.replace(/^DATABASE_URL=$/m,`DATABASE_URL=postgresql://${runtime}:${runtimePassword}@db:5432/${db}`));
  bootstrap+=`CREATE ROLE ${owner} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE ${runtime} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE ${db} OWNER ${owner};
REVOKE CONNECT,TEMPORARY ON DATABASE ${db} FROM PUBLIC;
\\connect ${db}
SET ROLE ${owner};
\\i /ajtool-db/migrate.sql
\\set runtime_role ${runtime}
\\i /ajtool-db/runtime-role.sql
RESET ROLE;
`;
}
save('bootstrap.sql',bootstrap);
console.log('Prepared new local-only open-mode demo. Credentials stay in .env.carlos-local; no login or Keycloak required.');

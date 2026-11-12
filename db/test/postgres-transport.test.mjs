import {test} from 'node:test';
import assert from 'node:assert/strict';
for(const tool of ['calculate-cpk-ppk','run-msa-analysis']){
 const {databaseTransport}=await import(`../../tools/${tool}/src/platform/postgres-transport.js`);
 const pg=(await import(`../../tools/${tool}/node_modules/pg/lib/index.js`)).default;
 test(`${tool}: public database verifies TLS despite URL sslmode overrides`,()=>{
   for(const mode of ['require','no-verify','disable','prefer','verify-full']){
     const config=databaseTransport(`postgresql://synthetic:synthetic@public.example/test?sslmode=${mode}&sslrootcert=untrusted&application_name=rc`);
     const client=new pg.Client(config);
     assert.equal(client.connectionParameters.ssl.rejectUnauthorized,true);
     assert.equal(new URL(config.connectionString).searchParams.get('application_name'),'rc');
     assert.equal(new URL(config.connectionString).searchParams.has('sslmode'),false);
   }
 });
 test(`${tool}: local and private network paths retain explicit plaintext scope`,()=>{
   for(const host of ['localhost','127.0.0.1','[::1]','db','postgres','service.railway.internal'])assert.equal(databaseTransport(`postgresql://u:p@${host}/test`).ssl,false);
 });
 test(`${tool}: private verified TLS opt-in keeps certificate verification`,()=>{
   for(const mode of ['require','verify-ca','verify-full']) {
     const client=new pg.Client(databaseTransport(`postgresql://u:p@127.0.0.1/test?sslmode=${mode}`));
     assert.equal(client.connectionParameters.ssl.rejectUnauthorized,true);
   }
 });
 test(`${tool}: deceptive host or credentials cannot disable public TLS`,()=>{
   for(const url of ['postgresql://u:p%40db@public.example/test','postgresql://u:p@db.evil.example/test','postgresql://u:p@service.railway.internal.evil.example/test','postgresql://u:p@public.example/test?note=.railway.internal'])assert.equal(databaseTransport(url).ssl.rejectUnauthorized,true);
 });
 test(`${tool}: malformed database URL is rejected`,()=>{assert.throws(()=>databaseTransport('invalid'));});
}

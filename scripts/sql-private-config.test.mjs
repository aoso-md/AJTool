import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionFor,mergePrivateConfig} from './sql-private-config.mjs';
test('special characters survive URI roundtrip and cannot change target',()=>{
 const password='synthetic:@/#?% $ñ\"';const u=new URL(connectionFor('postgres',password));
 assert.equal(decodeURIComponent(u.password),password);assert.equal(u.hostname,'aws-1-us-west-2.pooler.supabase.com');assert.equal(u.port,'5432');assert.equal(u.searchParams.get('sslmode'),'verify-full');assert.ok(u.searchParams.get('sslrootcert').endsWith('.crt'));
});
test('runtime identity stays independent',()=>{assert.equal(new URL(connectionFor('ajtool_service','synthetic')).username,'ajtool_service.lcteryhtsynrxgfpvryt');assert.throws(()=>connectionFor('other','synthetic'));});
test('saving migrator preserves comments and runtime setting',()=>{assert.equal(mergePrivateConfig('# private\nAJTOOL_MIGRATOR_DATABASE_URL=\nAJTOOL_TARGET_DATABASE_URL=existing\n','AJTOOL_MIGRATOR_DATABASE_URL','synthetic'),'# private\nAJTOOL_MIGRATOR_DATABASE_URL=synthetic\nAJTOOL_TARGET_DATABASE_URL=existing\n');});
test('existing credentials and duplicates fail closed',()=>{assert.throws(()=>mergePrivateConfig('AJTOOL_MIGRATOR_DATABASE_URL=existing','AJTOOL_MIGRATOR_DATABASE_URL','synthetic'));assert.throws(()=>mergePrivateConfig('AJTOOL_TARGET_DATABASE_URL=\nAJTOOL_TARGET_DATABASE_URL=','AJTOOL_TARGET_DATABASE_URL','synthetic'));});

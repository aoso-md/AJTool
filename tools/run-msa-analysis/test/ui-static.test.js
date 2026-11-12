import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/platform/app.js';
test('built UI serves from hidden workspace directories and API misses stay JSON',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'.ajtool-ui-'));
 await writeFile(join(dir,'index.html'),'<!doctype html><html><body>synthetic UI</body></html>');
 const app=createApp({tool:{id:'test',version:'1'},config:{uiDistDir:dir},core:{configured:false},store:{ping:async()=>true,tier:()=>({tier:'memory'})},poller:{status:()=>({})},publisher:{mode:'shadow'},registerRoutes(){},log:{error(){}}});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try {const base=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(base+'/');assert.equal(response.status,200);assert.match(await response.text(),/synthetic UI/);
 const api=await fetch(base+'/api/does-not-exist');assert.equal(api.status,404);assert.match(api.headers.get('content-type'),/json/);
 } finally {await new Promise(resolve=>server.close(resolve));assert.ok(dir.startsWith(join(tmpdir(),'.ajtool-ui-')));await rm(dir,{recursive:true,force:true});}
});

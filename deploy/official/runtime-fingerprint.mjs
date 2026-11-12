// Source/build verification only. Does not read env, studies, DB or process memory.
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2]||'/app');
const pkg=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
if(!['calculate-cpk-ppk','run-msa-analysis'].includes(pkg.name))throw new Error('unapproved_source_root');
const names=['package.json','pnpm-lock.yaml'];
function walk(folder){for(const name of readdirSync(resolve(root,folder))){const rel=folder+'/'+name,stat=lstatSync(resolve(root,rel));if(stat.isSymbolicLink())throw new Error('symlink_refused');if(stat.isDirectory())walk(rel);else names.push(rel);}}
walk('src');walk('web/dist');
const files={};for(const name of names.sort()){
 const data=readFileSync(resolve(root,name));const text=/\.(js|json|yaml|html|css|svg|txt)$/.test(name);
 files[name]=createHash('sha256').update(text?Buffer.from(data.toString('utf8').replace(/\r\n/g,'\n')):data).digest('hex');
}
const dependencies=Object.fromEntries(['express','pg','openid-client'].map(name=>[name,JSON.parse(readFileSync(resolve(root,'node_modules',name,'package.json'),'utf8')).version]));
console.log(JSON.stringify({dependencies,tool:pkg.name.replace(/-/g,'_'),version:pkg.version,node:process.version,normalization:'UTF8-LF for source/text; bytes for binary',files},null,2));

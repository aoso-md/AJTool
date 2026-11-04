import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const required=['src/server.js','src/tool.js','package.json','pnpm-lock.yaml','web/dist/index.html'];
function valid(doc,expected){return doc&&['calculate_cpk_ppk','run_msa_analysis'].includes(doc.tool)&&typeof doc.version==='string'&&typeof doc.node==='string'&&doc.normalization==='UTF8-LF for source/text; bytes for binary'&&doc.files&&required.every(k=>/^[a-f0-9]{64}$/.test(doc.files[k]||''))&&Object.values(doc.files).every(v=>/^[a-f0-9]{64}$/.test(v))&&doc.dependencies&&['express','pg','openid-client'].every(k=>typeof doc.dependencies[k]==='string')&&(!expected||/^[a-f0-9]{40}$/.test(doc.sourceCommit||''));}
export function compareFingerprints(expected,actual){
 if(!valid(expected,true)||!valid(actual,false))return {matches:false,reason:'invalid_or_unbound_fingerprint'};
 const differences=[...new Set([...Object.keys(expected.files),...Object.keys(actual.files)])].filter(k=>expected.files[k]!==actual.files[k]);
 const sameDependencies=['express','pg','openid-client'].every(k=>expected.dependencies[k]===actual.dependencies[k]);
 const matches=expected.tool===actual.tool&&expected.version===actual.version&&expected.node===actual.node&&sameDependencies&&differences.length===0;
 return {matches,tool:actual.tool,sourceCommit:expected.sourceCommit,differences,runtimeMatches:expected.node===actual.node&&sameDependencies,privateDataRead:false};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 let result;try{const [e,a]=process.argv.slice(2);result=compareFingerprints(JSON.parse(readFileSync(e,'utf8')),JSON.parse(readFileSync(a,'utf8')));}catch{result={matches:false,error:'invalid_fingerprint_inputs'};}
 console.log(JSON.stringify(result));if(!result.matches)process.exitCode=1;
}

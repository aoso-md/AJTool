import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareFingerprints} from '../../deploy/official/compare-fingerprint.mjs';
const baseline={tool:'calculate_cpk_ppk',version:'2.0.0',node:'v22.23.4',sourceCommit:'a'.repeat(40),normalization:'UTF8-LF for source/text; bytes for binary',dependencies:{express:'5.2.1',pg:'8.23.1','openid-client':'6.8.4'},files:Object.fromEntries(['src/server.js','src/tool.js','package.json','pnpm-lock.yaml','web/dist/index.html'].map(k=>[k,'b'.repeat(64)]))};
test('code and runtime fingerprint matches a commit-bound approved artifact',()=>assert.equal(compareFingerprints(baseline,structuredClone(baseline)).matches,true));
test('empty or commit-unbound fingerprints never accept',()=>{assert.equal(compareFingerprints({},{}).matches,false);assert.equal(compareFingerprints({...baseline,sourceCommit:null},baseline).matches,false);});
test('changed or extra files fail verification',()=>{for(const files of [{...baseline.files,'src/tool.js':'c'.repeat(64)},{...baseline.files,'src/extra.js':'c'.repeat(64)}])assert.equal(compareFingerprints(baseline,{...baseline,files}).matches,false);});
test('wrong tool, Node or resolved dependency cannot masquerade as same release',()=>{for(const change of [{tool:'run_msa_analysis'},{node:'v24.0.0'},{dependencies:{...baseline.dependencies,pg:'0.0.0'}}])assert.equal(compareFingerprints(baseline,{...baseline,...change}).matches,false);});

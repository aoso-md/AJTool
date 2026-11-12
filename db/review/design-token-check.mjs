// Enforce established ORCA palette parity across both independently built tools.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../../',import.meta.url);
const design=readFileSync(new URL('DESIGN.md',root),'utf8');
const colors=Object.fromEntries([...design.matchAll(/^  ([\w]+): '(#[a-f\d]{6})'$/gmi)].map(m=>[m[1],m[2]]));
assert.equal(Object.keys(colors).length,12);
const aliases={background:'bg',success:'ok',warning:'warn'};
for(const tool of ['calculate-cpk-ppk','run-msa-analysis']){
  const css=readFileSync(new URL(`tools/${tool}/web/src/index.css`,root),'utf8');
  for(const [name,value] of Object.entries(colors)){
    const runtime=css.match(new RegExp(`--color-${aliases[name]||name}:\\s*(#[a-f\\d]{6})`,'i'))?.[1];
    assert.equal(runtime,value,`${tool}: ${name} must follow DESIGN.md`);
  }
  assert.match(css,/--text-2xs:\s*0\.75rem/);
  assert.match(css,/--text-2xs--line-height:\s*1\.125rem/);
  assert.match(css,/--font-sans: 'IBM Plex Sans'/);
  assert.match(css,/--font-mono: 'IBM Plex Mono'/);
}
console.log('PASS: both tools retain the 12 ORCA palette tokens, IBM Plex fonts and documented 12px/18px metadata scale');

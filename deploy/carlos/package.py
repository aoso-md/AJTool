"""Package the exact candidate for Carlos, excluding local credentials/demos."""
from pathlib import Path
import subprocess,hashlib,json,zipfile
root=Path(__file__).resolve().parents[2]
out=root/'artifacts/entrega-carlos-20261027'
paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root).decode().split('\0')
roots={'.dockerignore','.gitignore','.gitattributes','railway.toml'}
files=[]
for name in paths:
    if not name or not (root/name).is_file():continue
    if name.startswith(('tools/','docker/','db/','deploy/carlos/','.github/')) or name in roots or name=='docs/ENTREGA-CARLOS-20261027.md':
        if name in ['db/review/public-sso-probe.mjs','db/review/browser-review.mjs','db/review/preview-server.mjs']:continue
        files.append(root/name)
for service in ['calculate-cpk-ppk','run-msa-analysis']:
    files.extend(p for p in (root/'tools'/service/'web/dist').rglob('*') if p.is_file())
# Sanitized evidence only: no dumps, credential files, browser profile, or earlier ZIPs.
for name in ['cpk-build.txt','msa-build.txt','cpk-image-build.txt','msa-image-build.txt','cpk-tests.txt','msa-tests.txt','postgres-run.txt','open-create.json','open-recover.json','images.json','review.json']:
    p=out/name
    if p.exists():files.append(p)
files.extend(p for p in (out/'postgres').glob('*.txt') if p.is_file())
manifest=[]
with zipfile.ZipFile(out/'AJTool-entrega-Carlos-20261027.zip','x',zipfile.ZIP_DEFLATED)as archive:
    intro=(root/'deploy/carlos/README.md').read_bytes()
    archive.writestr('README.md',intro)
    manifest.append({'path':'README.md','sha256':hashlib.sha256(intro).hexdigest()})
    for path in sorted(set(files)):
        name=path.relative_to(root).as_posix()
        if any(part=='node_modules' or part.startswith('.env.') for part in path.parts):
            if path.name!='.env.example':raise RuntimeError('Private path excluded')
        data=path.read_bytes();manifest.append({'path':name,'sha256':hashlib.sha256(data).hexdigest()});archive.writestr(name,data)
    archive.writestr('MANIFEST.json',json.dumps(manifest,indent=2)+'\n')
result={'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root).decode().strip(),'includesUncommittedChanges':True,'files':len(manifest),'packageSha256':hashlib.sha256((out/'AJTool-entrega-Carlos-20261027.zip').read_bytes()).hexdigest(),'manifest':manifest}
(out/'delivery-manifest.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
(out/'SHA256.txt').write_text(result['packageSha256']+'  AJTool-entrega-Carlos-20261027.zip\n',encoding='utf8')
print(f'Delivery created: {len(manifest)} files; no private demo or credentials.')

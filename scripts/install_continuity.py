"""Install small memory pointers only; preserve existing instructions and code."""
from pathlib import Path
import argparse,hashlib,json

ROOT=Path(__file__).resolve().parents[1]
MARKER='<!-- AJTOOL_SHARED_MEMORY_V1 -->'
VAULT='C:/Users/aabaro/OsOs/obsidian_vault'
ENTRY=VAULT+'/06_Agents_Reports/ajtool_continuity/AJTool - Continuidad.md'
GLOBAL=f'''{MARKER}
## Continuidad entre agentes

Antes de empezar trabajo de un proyecto, buscar su memoria y traspaso existentes en el repo y en la bóveda OSOS ({VAULT}). Consultar fuentes antes de volver a pedir información o crear infraestructura. Registrar acciones materiales, resultados y evidencia sin secretos; actualizar el traspaso al cerrar una fase. No asumir sincronización entre chats o clones.

Para AJTool / tools de calidad / ORCA Labs, leer primero `{ENTRY}` y seguir su snapshot vigente. Allí están los proyectos Supabase/Railway ya identificados, decisiones, fuentes y pendientes. No confundir demos locales con producción. No cargar todo el contexto personal o de otros proyectos si no corresponde a la tarea.
'''
PROJECT=f'''{MARKER}
# AJTool — recuperación obligatoria de contexto

Antes de actuar o pedir información a Angel, leer `{ENTRY}` y seguir START-HERE, CURRENT y HANDOFF. La bóveda es la memoria compartida; este checkout conserva su propio código y diff. No asumir que coincide con el candidato probado en `{ROOT.as_posix()}` ni copiar/sobrescribir cambios entre clones.

Registrar cada acción material y evidencia en la continuidad del proyecto y cerrar la fase con un traspaso. La herramienta de registro/sincronización está en `{ROOT.as_posix()}/scripts/continuity.py`. No guardar secretos ni datos reales en Obsidian. Si no se puede acceder, informar el bloqueo; nunca reemplazarlo por la suposición de que el proyecto no existe.

Consultar antes de recrear Supabase/Railway o volver a pedir nombres. Mantener separados estado histórico, local probado y aceptación remota. No reiniciar ni desplegar servicios con RAM sin conservación verificada y autorización aplicable.
'''
TARGETS={
 Path('C:/Users/aabaro/.codex/AGENTS.md'):GLOBAL,
 Path('C:/Users/aabaro/.claude/CLAUDE.md'):GLOBAL,
 Path('C:/Users/aabaro/AJTool/AGENTS.md'):PROJECT,
 Path('C:/Users/aabaro/AJTool/CLAUDE.md'):PROJECT,
 Path('C:/Users/aabaro/Documents/GitHub/angel-joaquin-quality-tools/AGENTS.md'):PROJECT,
 Path('C:/Users/aabaro/Documents/GitHub/angel-joaquin-quality-tools/CLAUDE.md'):PROJECT,
}
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
 planned=[]
 for path,block in TARGETS.items():
  if path.is_symlink():raise SystemExit('Symlinked instruction path refused')
  if not path.parent.is_dir():raise SystemExit('Existing project/configuration directory required: '+str(path.parent))
  old=path.read_bytes() if path.exists() else b''
  if MARKER.encode() in old:
   if block.encode() not in old:raise SystemExit('Existing pointer was edited; preserve it and review: '+str(path))
   new=old
  else:new=old+(b'\n\n' if old else b'')+block.encode()
  planned.append((path,old,new))
 receipt=[];backup=ROOT/'artifacts/continuity-20261027/instructions-backup'
 if args.apply:backup.mkdir(parents=True,exist_ok=True)
 for path,old,new in planned:
  h=hashlib.sha256(old).hexdigest();changed=old!=new
  if args.apply and changed:
   if old:
    name=hashlib.sha256(str(path).encode()).hexdigest()[:12]+'-'+h[:12]+'.md'
    dest=backup/name
    if dest.exists() and dest.read_bytes()!=old:raise SystemExit('Backup conflict')
    if not dest.exists():dest.write_bytes(old)
   # Recheck current bytes so concurrent edits are never overwritten.
   if (path.read_bytes() if path.exists() else b'')!=old:raise SystemExit('Concurrent instruction edit detected')
   if path.exists():
    with path.open('ab')as out:out.write(new[len(old):])
   else:
    with path.open('xb')as out:out.write(new)
  receipt.append({'path':str(path),'changed':changed,'previousSha256':h,'resultSha256':hashlib.sha256(new).hexdigest(),'existingContentPreserved':new.startswith(old)})
 result={'applied':args.apply,'targets':receipt}
 if args.apply:(ROOT/'artifacts/continuity-20261027/instructions-receipt.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
 print(json.dumps(result,indent=2))
if __name__=='__main__':main()

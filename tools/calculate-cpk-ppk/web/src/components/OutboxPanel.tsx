import {useState} from 'react';
import {useResource} from '../lib/useResource';
import {api} from '../lib/api';
import {Button,Field,Input,Panel,Table,Mono,Loading,ErrorState,formatTime} from './primitives';
import {PublishChip} from './StudyMeta';
import {Dialog} from './Dialog';
import type {Actor,PublishState} from '../lib/types';
interface Record {outbox_id:string;event_id:string;mode:string;state:PublishState;attempts:number;next_attempt_at:string|null;last_error_class:string|null;}
export function OutboxPanel({actor}:{actor:Actor|null}) {
 const {data,error,loading,reload}=useResource(()=>api.get<{records:Record[]}>('/api/outbox'),[],10000);
 const [selected,setSelected]=useState<Record|null>(null);const [reason,setReason]=useState('');const [busy,setBusy]=useState(false);const [failure,setFailure]=useState<string|null>(null);
 const canRecover=actor?.kind==='open'||actor?.kind==='service'||['QualityEngineer','QualityManager','TechnicalAuthority','QualityDirector'].includes(actor?.role||'');
 async function recover(){if(!selected)return;setBusy(true);setFailure(null);try{await api.post(`/api/outbox/${selected.outbox_id}/recover`,{reason});setSelected(null);setReason('');await reload();}catch(e){setFailure(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 return <Panel title="Entregas a la plataforma" subtitle="Últimos 100 registros. Guardado, en cola y entrega confirmada son estados distintos.">
  {loading&&!data?<Loading label="Leyendo entregas"/>:error&&!data?<ErrorState title="No se pudieron leer las entregas" detail={error.message}/>:<Table rows={data?.records||[]} getRowKey={r=>r.outbox_id} empty="No hay entregas registradas." columns={[
   {key:'id',header:'Evento',render:r=><Mono>{r.event_id}</Mono>},
   {key:'state',header:'Estado',render:r=><PublishChip publish={{state:r.state}}/>},
   {key:'mode',header:'Modo',render:r=>r.mode==='shadow'?'Sombra · no se envía':'Entrega habilitada'},
   {key:'attempts',header:'Intentos',render:r=><Mono>{r.attempts}</Mono>},
   {key:'next',header:'Próximo intento',render:r=><Mono>{formatTime(r.next_attempt_at)}</Mono>},
   {key:'action',header:'Acción',render:r=>canRecover&&r.mode==='live'&&['blocked_auth','blocked_destination','quarantined'].includes(r.state)?<Button onClick={()=>{setSelected(r);setFailure(null);}}>Revisar envío</Button>:null}
  ]}/>}
  {selected&&<Dialog title="Reintentar una entrega revisada" subtitle="Confirme que se corrigió la causa. Se conserva el mismo evento y se registra su identidad y motivo." busy={busy} onClose={()=>setSelected(null)} footer={<><Button onClick={()=>setSelected(null)} disabled={busy}>Cancelar</Button><Button variant="primary" loading={busy} disabled={reason.trim().length<8} onClick={()=>void recover()}>Registrar y reintentar</Button></>}>
   <Field label="Motivo de recuperación" required hint="Al menos 8 caracteres; queda en el historial."><Input value={reason} onChange={e=>setReason(e.target.value)}/></Field>
   {failure&&<ErrorState title="No se pudo recuperar el envío" detail={failure}/>}
  </Dialog>}
 </Panel>;
}

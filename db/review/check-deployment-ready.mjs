// Read-only acceptance for official AJTool endpoints. No tokens or study data.
import {pathToFileURL} from 'node:url';

const targets=new Map([
  ['https://ccp.orcalabs.mx/ready','calculate_cpk_ppk'],
  ['https://rma.orcalabs.mx/ready','run_msa_analysis']
]);
export function readinessErrors(doc,tool,{cutover=false}={}){
  const errors=[];
  if(doc?.status!=='ready')errors.push('service_not_ready');
  if(doc?.tool!==tool)errors.push('wrong_tool');
  if(doc?.auth!=='open')errors.push('expected_open_authentication');
  if(doc?.persistence?.tier!=='postgres')errors.push('expected_postgres');
  if(doc?.persistence?.durable!==true)errors.push('storage_not_durable');
  if(cutover&&doc?.publish!=='shadow')errors.push('expected_shadow');
  if(cutover&&doc?.poller?.enabled!==false)errors.push('expected_polling_disabled');
  return errors;
}
export function validateTarget(url,tool){
  if(targets.get(url)!==tool)throw new Error('Only the matching official AJTool /ready endpoint is allowed');
}
async function main(){
  const args=process.argv.slice(2);const get=name=>args[args.indexOf(name)+1];
  const url=get('--url'),tool=get('--tool');validateTarget(url,tool);
  const attempts=Number(args.includes('--attempts')?get('--attempts'):1);
  if(!Number.isInteger(attempts)||attempts<1||attempts>30)throw new Error('attempts must be 1..30');
  let last=[];
  for(let i=1;i<=attempts;i++){
    try{
      const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{accept:'application/json'}});
      if(!response.ok)last=['http_'+response.status];
      else if(!(response.headers.get('content-type')||'').includes('application/json'))last=['expected_json'];
      else last=readinessErrors(await response.json(),tool,{cutover:args.includes('--cutover')});
    }catch{last=['endpoint_unavailable'];}
    console.log(JSON.stringify({tool,attempt:i,accepted:last.length===0,reasons:last}));
    if(!last.length)return;
    if(i<attempts)await new Promise(resolve=>setTimeout(resolve,5000));
  }
  process.exitCode=1;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  main().catch(()=>{console.error('Deployment readiness configuration invalid');process.exitCode=1;});
}

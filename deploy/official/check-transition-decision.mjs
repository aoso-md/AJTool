// A data-retention decision is independent from certification of the new database.
import {pathToFileURL} from 'node:url';
const tools=new Set(['calculate_cpk_ppk','run_msa_analysis']);
export function decisionErrors(d,{tool,revision,now=Date.now()}){
 const e=[];
 if(!tools.has(tool)||!/^([a-f0-9]{40})$/.test(revision||''))return ['invalid_release_identity'];
 if(!d||typeof d!=='object')return ['data_owner_decision_missing'];
 if(d.tool!==tool)e.push('wrong_tool');if(d.revision!==revision)e.push('revision_not_approved');
 if(typeof d.approvedBy!=='string'||d.approvedBy.trim().length<3)e.push('data_owner_missing');
 if(typeof d.evidenceReference!=='string'||d.evidenceReference.trim().length<8)e.push('approval_evidence_missing');
 const at=Date.parse(d.approvedAtUtc);if(!Number.isFinite(at)||at>now+300000)e.push('approval_timestamp_invalid');
 if(d.action==='discard_current_ram'){
  if(d.explicitlyAcceptsHistoricalLoss!==true)e.push('historical_loss_not_explicitly_accepted');
  // An approved discard never requires an impossible exporter.
 }else if(d.action==='rebuild_from_core'){
  if(d.historicalSourceVerified!==true || typeof d.sourceCutoff!=='string' ||
     !/^(0|[1-9]\d{0,18})$/.test(d.sourceCutoff) || BigInt(d.sourceCutoff)>9223372036854775807n) e.push('historical_source_not_verified');
  if(d.acceptsReconstructionDifferences!==true) e.push('reconstruction_differences_not_accepted');
  if(typeof d.manualData?.evidenceReference!=='string'||d.manualData.evidenceReference.trim().length<8) e.push('manual_inventory_evidence_missing');
  if(d.manualData?.action==='discard'){
   if(d.manualData.explicitlyAcceptsLoss!==true) e.push('manual_loss_not_accepted');
  }else if(d.manualData?.action==='preserve'){
   if(d.manualData.restoreVerified!==true||!(/^[a-f0-9]{64}$/).test(d.manualData.manifestSha256||'')) e.push('manual_restore_not_verified');
  }else if(d.manualData?.action!=='none_verified') e.push('manual_disposition_missing');
 }else if(d.action==='preserve_current_ram'){
  if(!d.protection?.allActiveInstancesCovered||!d.protection?.consistentCut||!d.protection?.restoreVerified)e.push('history_protection_not_verified');
  if(!/^[a-f0-9]{64}$/.test(d.protection?.manifestSha256||''))e.push('protection_manifest_hash_missing');
  if(typeof d.protection?.evidenceReference!=='string'||d.protection.evidenceReference.length<8)e.push('protection_evidence_missing');
 }else e.push('data_owner_decision_pending');
 if(d.productionChangeApproved!==true)e.push('production_change_not_approved');
 return e;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];let d;
 try{d=JSON.parse(process.env.AJTOOL_DATA_DECISION_JSON||'null');}catch{d=null;}
 const errors=decisionErrors(d,{tool:arg('--tool'),revision:arg('--revision')});
 console.log(JSON.stringify({transitionAllowed:!errors.length,tool:arg('--tool'),reasons:errors,authorizesDataExtraction:false}));
 if(errors.length)process.exitCode=1;
}

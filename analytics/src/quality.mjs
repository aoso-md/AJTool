export const toolNames={calculate_cpk_ppk:'CPK / PPK',run_msa_analysis:'MSA'};
export function finite(value){return typeof value==='number'&&Number.isFinite(value);}
export function qualityFlags(s){
  const flags=[];const r=s.result||{};
  if(s.documentIdentityMismatch)flags.push('identity_mismatch');
  if(s.documentTimeMismatch||!Number.isFinite(Date.parse(s.createdAt))||!Number.isFinite(Date.parse(s.updatedAt))||Date.parse(s.updatedAt)<Date.parse(s.createdAt))flags.push('invalid_timestamp');
  if(('documentCreatedAt' in s&&Date.parse(s.documentCreatedAt)!==Date.parse(s.createdAt))||('documentUpdatedAt' in s&&Date.parse(s.documentUpdatedAt)!==Date.parse(s.updatedAt)))flags.push('document_timestamp_mismatch');
  if('documentStatus' in s&&s.documentStatus!==s.status)flags.push('document_status_mismatch');
  if(Date.parse(s.createdAt)>Date.now()+300000)flags.push('future_timestamp');
  if(!s.source)flags.push('missing_provenance');
  if(s.platformLineageUnresolved)flags.push('unresolved_event_lineage');
  if(!s.plantId)flags.push('missing_plant');
  flags.push('unit_not_recorded','method_version_not_recorded');
  if(!s.method)flags.push('method_not_recorded');
  if(s.invalidRawValues>0)flags.push('invalid_raw_values');
  if(s.tool==='calculate_cpk_ppk'&&(s.spec?.version==null||s.spec.version===''))flags.push('spec_version_missing');
  if(s.status==='completed'){
    const keys=s.tool==='calculate_cpk_ppk'?['cp','cpk','pp','ppk','mean']:['repeatability','reproducibility','grr','partVariation','totalVariation','gageRRPercent','ndc'];
    if(keys.some(k=>!finite(r[k])))flags.push('incomplete_or_nonfinite_result');
    if(s.tool==='calculate_cpk_ppk'){
      if(s.rawCount!==r.sampleSize)flags.push('raw_count_mismatch');
      if(finite(s.rawMean)&&finite(r.mean)&&Math.abs(s.rawMean-r.mean)>0.00001)flags.push('raw_mean_mismatch');
    }else{
      if(s.rawCount!==r.parts*r.appraisers*r.trials)flags.push('raw_count_mismatch');
      if(finite(r.grr)&&finite(r.repeatability)&&finite(r.reproducibility)&&Math.abs(r.grr-Math.hypot(r.repeatability,r.reproducibility))>0.000002)flags.push('grr_components_mismatch');
      if(finite(r.grr)&&finite(r.totalVariation)&&r.totalVariation>0&&Math.abs(r.gageRRPercent-100*r.grr/r.totalVariation)>0.011)flags.push('grr_percent_mismatch');
    }
  }
  return flags;
}
export function comparability(s){
  // These fields are not durably captured by current tool writers. No invented version/unit.
  return {eligible:false,reason:s.tool==='calculate_cpk_ppk'?'Faltan unidad y versión del método; no se conectan estudios como una tendencia comparable.':'Faltan unidad y versión del método; no se atribuyen cambios de aptitud a instrumentos u operadores.'};
}
export const qualityLabels={document_timestamp_mismatch:"Fecha documental distinta al índice",document_status_mismatch:"Estado documental distinto al índice",identity_mismatch:'Identidad documental inconsistente',invalid_timestamp:'Fechas inconsistentes',future_timestamp:'Fecha futura',missing_provenance:'Sin procedencia',unresolved_event_lineage:'Evento de origen sin reconciliar',missing_plant:'Planta no documentada',unit_not_recorded:'Unidad no documentada',method_version_not_recorded:'Versión del método ausente',method_not_recorded:'Método no guardado',invalid_raw_values:'Lecturas inválidas',spec_version_missing:'Versión de especificación ausente',incomplete_or_nonfinite_result:'Resultado incompleto o no finito',raw_count_mismatch:'Conteo de lecturas distinto al resultado',raw_mean_mismatch:'Media calculada distinta a la guardada',grr_components_mismatch:'GRR no reconcilia con EV/AV',grr_percent_mismatch:'%GRR no reconcilia con GRR/TV'};

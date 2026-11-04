import {test} from 'node:test';
import assert from 'node:assert/strict';
import {targetDescriptor,PROJECT_REF} from '../review/check-supabase-target.mjs';
import {decisionErrors} from '../../deploy/official/check-transition-decision.mjs';
const revision='a'.repeat(40),tool='calculate_cpk_ppk';
const approval={tool,revision,approvedBy:'Synthetic Data Owner',approvedAtUtc:'2026-10-29T00:00:00Z',evidenceReference:'synthetic-test-only',productionChangeApproved:true};
test('approved discard permits transition without RAM exporter proof',()=>assert.deepEqual(decisionErrors({...approval,action:'discard_current_ram',explicitlyAcceptsHistoricalLoss:true},{tool,revision}),[]));
test('discard needs explicit data-loss approval',()=>assert.ok(decisionErrors({...approval,action:'discard_current_ram'},{tool,revision}).includes('historical_loss_not_explicitly_accepted')));
test('preserve choice blocks only transition until recovery evidence exists',()=>assert.ok(decisionErrors({...approval,action:'preserve_current_ram'},{tool,revision}).includes('history_protection_not_verified')));
test('verified preservation permits transition',()=>assert.deepEqual(decisionErrors({...approval,action:'preserve_current_ram',protection:{allActiveInstancesCovered:true,consistentCut:true,restoreVerified:true,manifestSha256:'b'.repeat(64),evidenceReference:'synthetic-restoration'}},{tool,revision}),[]));
test('pending decision, wrong SHA and missing production approval fail closed',()=>{
 assert.ok(decisionErrors(null,{tool,revision}).length);
 assert.ok(decisionErrors({...approval,action:'pending'},{tool,revision}).includes('data_owner_decision_pending'));
 assert.ok(decisionErrors({...approval,revision:'b'.repeat(40),action:'discard_current_ram',explicitlyAcceptsHistoricalLoss:true,productionChangeApproved:false},{tool,revision}).includes('revision_not_approved'));
});
test('Supabase accepts exact existing project direct/session targets',()=>{
 assert.equal(targetDescriptor(`postgresql://runtime:p@db.${PROJECT_REF}.supabase.co:5432/postgres`).mode,'direct');
 assert.equal(targetDescriptor(`postgresql://runtime.${PROJECT_REF}:p@aws-0-us-west-2.pooler.supabase.com:5432/postgres`).mode,'session');
});
test('Supabase rejects transaction mode, wrong project and deceptive host',()=>{
 for(const url of [`postgresql://runtime.${PROJECT_REF}:p@aws-0-us-west-2.pooler.supabase.com:6543/postgres`,'postgresql://runtime:p@db.other.supabase.co:5432/postgres',`postgresql://runtime:p@db.${PROJECT_REF}.supabase.co.evil.example/postgres`,`postgresql://runtime:p@db.${PROJECT_REF}.supabase.co/postgres?host=evil.example`])assert.throws(()=>targetDescriptor(url));
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {qualifyDiagnostics,satDecimalToMsat,channelScid} from '../diagnostics.js';
const at='2026-10-09T04:00:00Z',identity='node';
const projection=()=>({schema:1,identity,capturedAt:at,providers:{lndg:{status:'ok',version:'1.11.1',schemaFingerprint:'f12ae61382e1eff131904419106c3ddb51d30f2443990443ed65c848de419682',coverage:{start:at,end:at,complete:false,source:'selected diagnostic tables'},forwards:[],failures:[],failureRollups:[],rebalances:[]}}});
test('diagnostic amounts and SCIDs retain exact units beyond Number precision',()=>{
  assert.equal(satDecimalToMsat('349.136'),'349136');assert.equal(satDecimalToMsat('9007199254740993.003'),'9007199254740993003');
  assert.equal(channelScid('1066880321721991171'),'970322x536x3');
  assert.throws(()=>satDecimalToMsat('0.0001'),/precision/);assert.throws(()=>channelScid('18446744073709551616'),/range/);
});
test('stale, unknown or incompatible diagnostics cannot manufacture zero failures',()=>{
  const raw=projection();assert.equal(qualifyDiagnostics(raw,identity,at).lndg.status,'qualified');assert.equal(qualifyDiagnostics(raw,identity,at).lightningMate.failures,undefined);
  assert.equal(qualifyDiagnostics(raw,'other',at).lndg.status,'unavailable');assert.equal(qualifyDiagnostics(raw,identity,'2026-10-09T04:02:00Z').lndg.status,'unavailable');
  raw.providers.lndg.version='1.12.0';assert.equal(qualifyDiagnostics(raw,identity,at).lndg.status,'incompatible');raw.providers.lndg.version='1.11.1';raw.providers.lndg.schemaFingerprint='wrong';assert.equal(qualifyDiagnostics(raw,identity,at).lndg.forwards,undefined);
});
test('failed HTLCs remain attempts, rollups remain aggregates and pending fees remain unknown',()=>{
  const raw:any=projection();raw.providers.lndg.failures=[{id:1,at,chan_id_in:'10',chan_id_out:'20',amount:'12',missed_fee:'0.123',failure_detail:6,wire_failure:15}];
  raw.providers.lndg.failureRollups=[{at,chan_id_in:'10',chan_id_out:'20',htlc_count:4,amount_sum:48,fee_sum:'0.492'}];raw.providers.lndg.rebalances=[{id:1,status:1,value:'10000',fees:null}];
  const result:any=qualifyDiagnostics(raw,identity,at).lndg;assert.equal(result.failures[0].amountMsat,'12000');assert.equal(result.failures[0].distinctPaymentsUnknown,true);
  assert.match(result.failureRollups[0].granularity,/bucket/);assert.equal(result.rebalances[0].succeeded,false);assert.equal(result.rebalances[0].feeMsat,null);
});

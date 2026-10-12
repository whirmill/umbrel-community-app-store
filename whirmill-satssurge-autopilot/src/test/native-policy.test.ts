import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CanonicalModel} from '../canonical-model.js';
import {migrateCanonical} from './native-canonical-fixture.js';
import {NativePolicyCollector,decodeRoutingPolicy,NATIVE_POLICY_CONTRACT,type NativePolicySource} from '../native-policy.js';
const local='02'+'a'.repeat(64),peer='03'+'b'.repeat(64),other='02'+'c'.repeat(64),at='2026-10-10T12:00:00.000Z';
const binding={nodeId:local,network:'mainnet',sourceVersion:'0.21.3-beta',sourceInstance:'adapter-A'};
const stamp=(ms=0)=>new Date(Date.parse(at)+ms).toISOString();
const policy=(extra:any={})=>({time_lock_delta:40,min_htlc:'0',fee_base_msat:'1000',fee_rate_milli_msat:'250',disabled:false,max_htlc_msat:'18446744073709551615',last_update:0,inbound_fee_base_msat:-10,inbound_fee_rate_milli_msat:0,...extra});
const edge=(extra:any={})=>({channel_id:'1',node1_pub:local,node2_pub:peer,node1_policy:policy(),node2_policy:policy({fee_base_msat:'2000'}),...extra});
const update=(extra:any={})=>({chan_id:'1',advertising_node:local,connecting_node:peer,routing_policy:policy(),...extra});
function fixture(path=':memory:'){
 const db=new DatabaseSync(path);if(Number(db.prepare('PRAGMA user_version').get()?.user_version)===0)db.exec('PRAGMA user_version=6');migrateCanonical(db);
 let currentBinding=binding,raw:any=edge(),time=at,calls=0,fetchHook:(()=>void)|undefined;
 const source:NativePolicySource={contract:NATIVE_POLICY_CONTRACT,binding:()=>currentBinding,getChanInfo:async()=>{calls++;fetchHook?.();return raw;}};
 const model=new CanonicalModel(db),collector=new NativePolicyCollector(model,source,()=>time);
 return {db,model,source,collector,setRaw:(r:any)=>raw=r,setTime:(t:string)=>time=t,setBinding:(b:any)=>currentBinding=b,setFetchHook:(fn:()=>void)=>fetchHook=fn,calls:()=>calls,close:()=>db.close()};
}
const observations=(db:DatabaseSync)=>db.prepare("SELECT * FROM canonical_observations WHERE kind='native_policy' ORDER BY rowid").all() as any[];
const snapshot=(db:DatabaseSync)=>['canonical_observations','canonical_entities','canonical_evidence_links','canonical_coverage','canonical_projection_revisions'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all());
const code=(expected:string)=>(e:any)=>e.code===expected;

test('both snapshot directions require exactly one local endpoint and never retain peer or unrelated payload',async()=>{
 const f=fixture();try{f.setRaw(edge({custom_records:{secret:'EXCLUDED'},node1_policy:{...policy(),custom_records:{preimage:'EXCLUDED'}}}));const result=await f.collector.snapshot({captureId:'s1',channelIds:['1']});assert.equal(result.receipts.length,2);
 assert.equal(f.collector.policyState(binding,'1','outgoing').policy?.feeBaseMsat,'1000');assert.equal(f.collector.policyState(binding,'1','incoming').policy?.feeBaseMsat,'2000');
 const rows=observations(f.db);assert.equal(rows[0].original_timestamp,'0');assert.equal(rows[0].occurred_at,null);assert.equal(rows[0].source_version,binding.sourceVersion);assert.ok(rows.every(r=>r.original_digest.length===64));assert.doesNotMatch(JSON.stringify(rows),new RegExp(peer+'|EXCLUDED|preimage'));
 f.setRaw(edge({node1_pub:peer,node2_pub:local,node1_policy:policy({fee_base_msat:'3000'}),node2_policy:policy({fee_base_msat:'4000'})}));await f.collector.snapshot({captureId:'s2',channelIds:['1']});assert.equal(f.collector.policyState(binding,'1','outgoing').policy?.feeBaseMsat,'4000');assert.equal(f.collector.policyState(binding,'1','incoming').policy?.feeBaseMsat,'3000');
 }finally{f.close();}
});
test('absent, neither or both local endpoints reject the snapshot instead of node2 fallback',async()=>{
 for(const extra of [{node1_pub:undefined},{node1_pub:peer,node2_pub:other},{node2_pub:local},{channel_id:'2'}]){const f=fixture();try{f.setRaw(edge(extra));await assert.rejects(f.collector.snapshot({captureId:'bad',channelIds:['1']}),code('identity_mismatch'));assert.equal(observations(f.db).length,0);assert.equal(f.db.prepare("SELECT count(*) n FROM canonical_coverage WHERE status='checkpoint'").get()?.n,0);}finally{f.close();}}
});
test('every field-only change creates an immutable successor including CLTV disabled inbound min max and remote time',async()=>{
 const f=fixture();try{await f.collector.snapshot({captureId:'baseline',channelIds:['1']});const first=observations(f.db)[0],before={...first};
 const changes=[['time_lock_delta',41,'timeLockDelta'],['disabled',true,'disabled'],['inbound_fee_base_msat',-11,'inboundFeeBaseMsat'],['inbound_fee_rate_milli_msat',-1,'inboundFeeRatePpm'],['min_htlc','1','minHtlcMsat'],['max_htlc_msat','9000','maxHtlcMsat'],['fee_base_msat','1001','feeBaseMsat'],['fee_rate_milli_msat','251','feeRatePpm'],['last_update',1,'lastUpdate']] as const;
 let accumulated:any={};for(const [i,[key,value,field]] of changes.entries()){accumulated={...accumulated,[key]:value};f.setRaw(edge({node1_policy:policy(accumulated)}));f.setTime(stamp(i+1));await f.collector.snapshot({captureId:'change-'+i,channelIds:['1']});const row=observations(f.db).at(-2),payload=JSON.parse(row.payload);assert.deepEqual(payload.changedFields,[field]);assert.equal(payload.changeInterval.end,stamp(i+1));assert.equal(row.original_timestamp,String(accumulated.last_update??0));}
 assert.deepEqual({...f.model.observation(first.id)},before);assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);assert.throws(()=>f.db.prepare('UPDATE canonical_observations SET payload=? WHERE id=?').run('{}',first.id),/Immutable/);
 }finally{f.close();}
});
test('policy integers preserve zero signed inbound and int64/uint64 bounds without Number rounding',()=>{
 const decoded=decodeRoutingPolicy(policy({min_htlc:'-9223372036854775808',fee_base_msat:'9223372036854775807',fee_rate_milli_msat:'9007199254740993',inbound_fee_base_msat:-2147483648,inbound_fee_rate_milli_msat:2147483647,time_lock_delta:0}));assert.equal(decoded.policy?.minHtlcMsat,'-9223372036854775808');assert.equal(decoded.policy?.feeBaseMsat,'9223372036854775807');assert.equal(decoded.policy?.feeRatePpm,'9007199254740993');assert.equal(decoded.policy?.maxHtlcMsat,'18446744073709551615');assert.equal(decoded.policy?.inboundFeeBaseMsat,'-2147483648');assert.equal(decoded.policy?.timeLockDelta,'0');assert.equal(decoded.policy?.lastUpdate,'0');assert.equal(decoded.policy?.disabled,false);
 for(const extra of [{fee_base_msat:9007199254740993},{min_htlc:'-9223372036854775809'},{fee_base_msat:'9223372036854775808'},{max_htlc_msat:'18446744073709551616'},{inbound_fee_base_msat:-2147483649},{last_update:4294967296},{disabled:'false'},{time_lock_delta:-1}])assert.throws(()=>decodeRoutingPolicy(policy(extra)),code('malformed_policy'));
});
test('missing direction and missing policy fields stay unknown and do not certify channel operations',async()=>{
 const f=fixture();try{f.setRaw(edge({node1_policy:null,node2_policy:{disabled:false}}));await f.collector.snapshot({captureId:'missing',channelIds:['1']});const out=f.collector.policyState(binding,'1','outgoing'),incoming=f.collector.policyState(binding,'1','incoming');assert.equal(out.known,false);assert.equal(out.policy,null);assert.equal(incoming.known,false);assert.equal(incoming.policy?.feeBaseMsat,null);assert.equal(incoming.policy?.disabled,false);assert.equal(out.operationalChannelStateQualified,false);assert.equal(f.collector.policyState(binding,'2','outgoing').known,false);
 }finally{f.close();}
});
test('malformed snapshot and unsupported source have sanitized errors and no acquired observations',async()=>{
 const f=fixture();try{f.setRaw(edge({node1_policy:'PRIVATE'}));await assert.rejects(f.collector.snapshot({captureId:'bad',channelIds:['1']}),code('malformed_policy'));assert.equal(observations(f.db).length,0);assert.doesNotMatch(JSON.stringify(snapshot(f.db)),/PRIVATE/);(f.source as any).contract='unsupported';await assert.rejects(f.collector.snapshot({captureId:'unsupported',channelIds:['1']}),code('unsupported_source'));assert.throws(()=>f.collector.openEpoch(binding,'e1',at),code('unsupported_source'));
 }finally{f.close();}
});
test('snapshot has bounded channels and rechecks node network version and source instance across await',async()=>{
 const f=fixture();try{await assert.rejects(f.collector.snapshot({captureId:'big',channelIds:Array(101).fill('1')}),code('malformed_policy'));await assert.rejects(f.collector.snapshot({captureId:'duplicate',channelIds:['1','01']}),code('malformed_policy'));assert.equal(f.calls(),0);for(const changed of [{...binding,nodeId:other},{...binding,network:'testnet'},{...binding,sourceVersion:'different'},{...binding,sourceInstance:'adapter-B'}]){f.setBinding(binding);f.setFetchHook(()=>f.setBinding(changed));await assert.rejects(f.collector.snapshot({captureId:'moved',channelIds:['1']}),code('binding_mismatch'));assert.equal(observations(f.db).length,0);}
 }finally{f.close();}
});
test('snapshot capture receipts are restart-idempotent and conflicting queries cannot reuse a capture',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'policy-snapshot-')),path=join(dir,'synthetic.sqlite');let f=fixture(path);try{const first=await f.collector.snapshot({captureId:'s1',channelIds:['1']}),before=snapshot(f.db);f.close();f=fixture(path);assert.deepEqual(await f.collector.snapshot({captureId:'s1',channelIds:['1']}),first);assert.equal(f.calls(),0);assert.deepEqual(snapshot(f.db),before);await assert.rejects(f.collector.snapshot({captureId:'s1',channelIds:['2']}),code('receipt_conflict'));
 }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});
test('snapshots bound acquisition and detected changes to intervals without pretending atomic graph history',async()=>{
 const f=fixture();try{f.setFetchHook(()=>f.setTime(stamp(10)));await f.collector.snapshot({captureId:'first',channelIds:['1']});const original=JSON.parse(observations(f.db)[0].payload);assert.deepEqual(original.acquisitionInterval,{start:at,end:stamp(10)});f.setTime(stamp(20));f.setFetchHook(()=>f.setTime(stamp(30)));f.setRaw(edge({node1_policy:policy({disabled:true,last_update:500})}));const next=await f.collector.snapshot({captureId:'next',channelIds:['1']});const payload=JSON.parse(f.model.observation(next.receipts[0]!.observationId).payload);assert.deepEqual(payload.changeInterval,{start:at,end:stamp(30)});assert.equal(payload.snapshotFrozen,false);assert.equal(payload.sourceHistoryComplete,false);assert.equal(f.model.observation(next.receipts[0]!.observationId).occurred_at,null);
 }finally{f.close();}
});
test('failed snapshot transaction rolls back observations lineage projections and checkpoint before retry',async()=>{
 const f=fixture();try{const before=snapshot(f.db);await assert.rejects(f.collector.snapshot({captureId:'fault',channelIds:['1'],beforeCheckpoint:()=>{throw Error('atomic fault');}}),/atomic fault/);assert.deepEqual(snapshot(f.db),before);assert.equal(f.collector.policyState(binding,'1','outgoing').known,false);assert.equal((await f.collector.snapshot({captureId:'fault',channelIds:['1']})).receipts.length,2);
 }finally{f.close();}
});
test('graph advertisements explicitly map direction and retain no pubkeys or fake event timestamp',()=>{
 const f=fixture();try{const origin=f.collector.openEpoch(binding,'e1',at);assert.equal(f.collector.readiness(at).qualified,false);assert.throws(()=>f.collector.observeUpdate(update(),origin,{receiptId:'u1',observedAt:at}),code('not_ready'));f.collector.markReady(origin,at);
 f.collector.observeUpdate(update(),origin,{receiptId:'u1',observedAt:at});f.collector.observeUpdate(update({advertising_node:peer,connecting_node:local,routing_policy:policy({inbound_fee_base_msat:-100})}),origin,{receiptId:'u2',observedAt:stamp(1)});
 assert.equal(f.collector.policyState(binding,'1','incoming').policy?.inboundFeeBaseMsat,'-100');assert.equal(f.collector.policyState(binding,'1','outgoing').policy?.inboundFeeBaseMsat,'-10');assert.ok(observations(f.db).every(o=>o.occurred_at===null));assert.doesNotMatch(JSON.stringify(observations(f.db)),new RegExp(peer));assert.equal(f.collector.readiness(stamp(1)).qualified,true);
 }finally{f.close();}
});
test('graph transport receipts deduplicate exactly while equal later advertisements remain separate observations',()=>{
 const f=fixture();try{const origin=f.collector.openEpoch(binding,'e1',at);f.collector.markReady(origin,at);const first=f.collector.observeUpdate(update(),origin,{receiptId:'u1',observedAt:at}),before=snapshot(f.db);assert.deepEqual(f.collector.observeUpdate(update(),origin,{receiptId:'u1',observedAt:stamp(1)}),first);assert.deepEqual(snapshot(f.db),before);assert.throws(()=>f.collector.observeUpdate(update({routing_policy:policy({disabled:true})}),origin,{receiptId:'u1',observedAt:stamp(1)}),code('receipt_conflict'));f.collector.observeUpdate(update(),origin,{receiptId:'u2',observedAt:stamp(2)});assert.equal(observations(f.db).length,2);assert.deepEqual(JSON.parse(observations(f.db)[1].payload).changedFields,[]);
 }finally{f.close();}
});
test('per-open opaque session fences delayed callbacks gaps and readiness after disconnect or restart',()=>{
 const f=fixture();try{const old=f.collector.openEpoch(binding,'e1',at);f.collector.markReady(old,at);f.collector.closeEpoch(old,stamp(1),'disconnect');assert.equal(f.collector.readiness(stamp(1)).qualified,false);const current=f.collector.openEpoch(binding,'e1',stamp(2)),before=snapshot(f.db);assert.notEqual(current.session,old.session);assert.throws(()=>f.collector.markReady(old,stamp(3)),code('stale_session'));assert.throws(()=>f.collector.closeEpoch(old,stamp(3),'shutdown'),code('stale_session'));assert.throws(()=>f.collector.observeUpdate(update(),old,{receiptId:'late',observedAt:stamp(3)}),code('stale_session'));assert.deepEqual(snapshot(f.db),before);f.collector.markReady(current,stamp(3));f.collector.openEpoch(binding,'e2',stamp(4));assert.equal(f.collector.readiness(stamp(4)).qualified,false);assert.ok(f.db.prepare("SELECT details FROM canonical_coverage WHERE status='gap'").all().some((r:any)=>JSON.parse(r.details).reason==='restart_without_replay'));
 }finally{f.close();}
});
test('disk reopen requires a fresh per-open session and preserves original graph observations',()=>{
 const dir=mkdtempSync(join(tmpdir(),'policy-stream-')),path=join(dir,'synthetic.sqlite');let f=fixture(path);try{const old=f.collector.openEpoch(binding,'e1',at);f.collector.markReady(old,at);f.collector.observeUpdate(update(),old,{receiptId:'u1',observedAt:at});const before=observations(f.db);f.close();f=fixture(path);assert.equal(f.collector.readiness(stamp(1)).qualified,false);const current=f.collector.openEpoch(binding,'e1',stamp(1));assert.throws(()=>f.collector.markReady(old,stamp(2)),code('stale_session'));f.collector.markReady(current,stamp(2));assert.deepEqual(observations(f.db),before);assert.equal(f.collector.policyState(binding,'1','outgoing').known,true);
 }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});
test('graph admission rolls back cache-visible state and all canonical writes on checkpoint failure',()=>{
 const f=fixture();try{const origin=f.collector.openEpoch(binding,'e1',at);f.collector.markReady(origin,at);const before=snapshot(f.db);assert.throws(()=>f.collector.observeUpdate(update(),origin,{receiptId:'u1',observedAt:stamp(1),beforeCheckpoint:()=>{throw Error('atomic graph fault');}}),/fault/);assert.deepEqual(snapshot(f.db),before);assert.equal(f.collector.policyState(binding,'1','outgoing').known,false);f.collector.observeUpdate(update(),origin,{receiptId:'u1',observedAt:stamp(1)});assert.equal(f.collector.policyState(binding,'1','outgoing').known,true);assert.equal(f.db.prepare('PRAGMA quick_check').get()?.quick_check,'ok');
 }finally{f.close();}
});
test('graph malformed or nonlocal direction persists only a sanitized gap and never implies history completeness',()=>{
 const f=fixture();try{const origin=f.collector.openEpoch(binding,'e1',at);f.collector.markReady(origin,at);assert.throws(()=>f.collector.observeUpdate(update({advertising_node:peer,connecting_node:other,private_error:'EXCLUDED'}),origin,{receiptId:'bad',observedAt:stamp(1)}),code('identity_mismatch'));assert.equal(observations(f.db).length,0);assert.doesNotMatch(JSON.stringify(snapshot(f.db)),/EXCLUDED/);f.collector.observeUpdate(update(),origin,{receiptId:'valid',observedAt:stamp(2)});assert.equal(f.db.prepare("SELECT count(*) n FROM canonical_coverage WHERE status='complete'").get()?.n,0);const payload=JSON.parse(observations(f.db)[0].payload);assert.equal(payload.sourceHistoryComplete,false);assert.equal(payload.snapshotFrozen,false);assert.equal(payload.operationalChannelStateQualified,false);
 }finally{f.close();}
});


test('private graph unavailability is a policy evidence gap and readonly readiness expires without proof of freshness',async()=>{
 const f=fixture();try{f.source.getChanInfo=async()=>{throw Error('PRIVATE source path');};await assert.rejects(f.collector.snapshot({captureId:'private-channel',channelIds:['1']}),code('source_error'));assert.equal(f.collector.policyState(binding,'1','outgoing').known,false);assert.doesNotMatch(JSON.stringify(snapshot(f.db)),/PRIVATE source path/);
 const origin=f.collector.openEpoch(binding,'e1',at);f.collector.markReady(origin,at);assert.equal(f.collector.readiness(stamp(300001)).qualified,false);
 }finally{f.close();}
});
test('graph change detection does not fabricate a remote mutation interval from receipt times',()=>{
 const f=fixture();try{const origin=f.collector.openEpoch(binding,'e1',at);f.collector.markReady(origin,at);f.collector.observeUpdate(update(),origin,{receiptId:'u1',observedAt:at});f.collector.observeUpdate(update({routing_policy:policy({disabled:true,last_update:900})}),origin,{receiptId:'u2',observedAt:stamp(1)});const payload=JSON.parse(observations(f.db)[1].payload);assert.deepEqual(payload.changedFields,['disabled','lastUpdate']);assert.equal(payload.changeInterval,null);assert.equal(f.collector.policyState(binding,'1','outgoing').currentPolicyQualified,false);
 }finally{f.close();}
});


test('multi-channel snapshots remain bounded non-atomic acquisitions with both directions for every channel',async()=>{
 const f=fixture();try{let calls=0;f.source.getChanInfo=async channel=>{calls++;f.setTime(stamp(calls*10));return edge({channel_id:channel,node1_policy:policy({fee_base_msat:String(calls)})});};const result=await f.collector.snapshot({captureId:'two-channels',channelIds:['1','2']});assert.equal(result.receipts.length,4);assert.equal(calls,2);assert.equal(f.collector.policyState(binding,'1','outgoing').policy?.feeBaseMsat,'1');assert.equal(f.collector.policyState(binding,'2','outgoing').policy?.feeBaseMsat,'2');for(const row of observations(f.db)){const payload=JSON.parse(row.payload);assert.deepEqual(payload.acquisitionInterval,{start:at,end:stamp(20)});assert.equal(payload.snapshotFrozen,false);assert.equal(payload.sourceHistoryComplete,false);}
 }finally{f.close();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store.js';
import {CanonicalModel} from '../canonical-model.js';
import {NativeHtlcCollector,HTLC_DELIVERY_CAPABILITY} from '../native-htlc.js';
import {NativeLndSource,type NativeStreamOrigin} from '../native-lnd-source.js';
import {nativeFailureRollups,NATIVE_DELIVERY_ROLLUP_VERSION} from '../native-failure-aggregate.js';
import {canonicalDiagnostics} from '../canonical-consumers.js';
import {evidenceSource} from '../evidence-source.js';
import {EvidenceViews,boundedEvidenceEnvelope} from '../evidence-views.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const binding={nodeId:'02'+'11'.repeat(32),network:'mainnet',sourceVersion:'0.21.4-beta',sourceInstance:'synthetic-delivery-adapter'};
const at='2026-10-12T23:59:59.000Z',later='2026-10-13T00:00:00.000Z';
const raw=(variant='link_fail',amount='2000')=>({event_type:'FORWARD',incoming_channel_id:'1',outgoing_channel_id:'2',incoming_htlc_id:'3',outgoing_htlc_id:'4',timestamp_ns:'1791849599000000001',[variant==='link_fail'?'link_fail_event':variant==='forward'?'forward_event':'forward_fail_event']:variant==='forward_fail'?{}:{info:{incoming_amt_msat:'3000',outgoing_amt_msat:amount,incoming_timelock:500,outgoing_timelock:400},...(variant==='link_fail'?{wire_failure:'TEMPORARY_CHANNEL_FAILURE',failure_detail:'INSUFFICIENT_BALANCE',failure_string:'PRIVATE-FAILURE-DESCRIPTION'}:{})},invoice:'PRIVATE-INVOICE',payment_preimage:'PRIVATE-PREIMAGE'});
const count=(s:Store)=>Number(s.one('SELECT count(*) n FROM canonical_coverage WHERE capability=?',HTLC_DELIVERY_CAPABILITY).n);
const receipts=(s:Store)=>s.all('SELECT * FROM canonical_coverage WHERE capability=? ORDER BY rowid',HTLC_DELIVERY_CAPABILITY).map(r=>({...r,details:JSON.parse(r.details)}));
async function capture(s:Store,frames:any[],times:string[]=frames.map(()=>at),options:{epoch?:string;beforeCheckpoint?:()=>void}={}){
 const collector=new NativeHtlcCollector(new CanonicalModel(s.db)),epoch=options.epoch??'synthetic-epoch',session=collector.openEpoch(binding,epoch,times[0]??at),origin={binding,epoch,session};
 const seen:{value:any;origin:NativeStreamOrigin;at:string;result?:any}[]=[];
 const transport:any={getInfo:async()=>({identity_pubkey:binding.nodeId,version:binding.sourceVersion,chains:[{chain:'bitcoin',network:'mainnet'}]}),forwardingHistory:async()=>({}),listPayments:async()=>({}),getChanInfo:async()=>({}),listChannels:async()=>({}),subscribeChannelGraph:async()=>{},subscribeHtlcEvents:async(onFrame:any,onReady:any)=>{onReady();await onFrame({subscribed_event:{}});for(const frame of frames)await onFrame(frame);}};
 const source=new NativeLndSource({transport,...binding,chain:'bitcoin'});let admitted=0;
 try{
  const receipt=await source.subscribeHtlcEvents({onReady:o=>{if(o.kind==='subscribed')collector.admitSubscribed({...origin,kind:'subscribed',adapterSession:o.session,at:times[0]??at});},onEvent:(value,o)=>{const time=times[admitted++]??at,entry={value,origin:o,at:time,result:undefined as any};seen.push(entry);entry.result=collector.observe(value,time,{...origin,delivery:{adapterSession:o.session,ordinal:o.deliveryOrdinal!},beforeCheckpoint:options.beforeCheckpoint});}});
  return {receipt,seen,collector,origin};
 }finally{source.shutdown();}
}
test('adapter ordinals exclude ACK and private SEND/RECEIVE while equal callback payloads commit two receipts and one observation',async()=>{
 const s=new Store(':memory:');try{
  const f=await capture(s,[{...raw(),event_type:'SEND'},{...raw(),event_type:'RECEIVE'},raw(),raw()],[at,later]);
  assert.equal(f.receipt.reason,'eof');assert.equal(f.receipt.frames,5);assert.equal(f.receipt.filtered,2);assert.deepEqual(f.seen.map(e=>e.origin.deliveryOrdinal),[1,2]);
  assert.equal(count(s),2);assert.equal(s.one("SELECT count(*) n FROM canonical_observations WHERE kind='native_htlc'").n,1);
  const r=receipts(s);assert.notEqual(r[0].id,r[1].id);assert.equal(r[0].details.observationId,r[1].details.observationId);assert.equal(r[1].details.originalEnvelope.processingAt,later);assert.equal(r[0].details.record.timestampNs,r[1].details.record.timestampNs);
  assert.equal(r[0].details.adapterSession,f.receipt.session);assert.equal(r[0].details.collectorSession,f.origin.session);assert.deepEqual(r[0].details.binding,binding);
  assert.ok(r[0].details.subscriptionCoverageId);assert.equal(r[0].status,'partial');assert.equal(r[0].details.eventMultiplicityQualified,false);assert.equal(r[0].details.uniquePaymentCount,null);
  const e=f.seen[0]!,opts={...f.origin,delivery:{adapterSession:e.origin.session,ordinal:e.origin.deliveryOrdinal!}};
  const checkpoint=s.one("SELECT id FROM canonical_coverage WHERE capability='htlc_epoch_checkpoint' ORDER BY rowid DESC LIMIT 1").id;
  let atomic=false;const repeat=f.collector.observe(e.value,e.at,{...opts,beforeCheckpoint:()=>{atomic=s.db.isTransaction;}});assert.equal(repeat.duplicate,true);assert.equal(atomic,true);assert.equal(count(s),2);assert.equal(s.one("SELECT id FROM canonical_coverage WHERE capability='htlc_epoch_checkpoint' ORDER BY rowid DESC LIMIT 1").id,checkpoint);
  assert.equal(f.collector.observe(e.value,later,opts).reason,'conflicting_delivery');assert.equal(count(s),2);
  assert.equal(f.collector.observe(e.value,later,{...opts,delivery:{...opts.delivery,adapterSession:'wrong-session'}}).reason,'session_mismatch');
  assert.equal(f.collector.observe(e.value,later,{...opts,delivery:{...opts.delivery,ordinal:2}}).reason,'session_mismatch');
  assert.equal(f.collector.observe({...e.value,link_fail_event:{...e.value.link_fail_event,failure_detail:'UNKNOWN'}},later,opts).accepted,false);
  assert.equal(f.collector.observe(e.value,later,{...opts,binding:{...binding,network:'testnet'}}).reason,'binding_mismatch');
  f.collector.closeEpoch('disconnect',later,f.origin);const closed=s.one("SELECT id FROM canonical_coverage WHERE capability='htlc_epoch_checkpoint' ORDER BY rowid DESC LIMIT 1").id;assert.equal(f.collector.observe(e.value,e.at,opts).deliveryReceiptId,r[0].id);assert.equal(count(s),2);assert.equal(s.one("SELECT id FROM canonical_coverage WHERE capability='htlc_epoch_checkpoint' ORDER BY rowid DESC LIMIT 1").id,closed);
  const text=JSON.stringify(r);for(const secret of ['PRIVATE-FAILURE-DESCRIPTION','PRIVATE-INVOICE','PRIVATE-PREIMAGE'])assert.equal(text.includes(secret),false);
 }finally{s.close();}
});
test('delivery, observation and checkpoint rollback atomically and persisted receipts survive reopen without promoting a new subscription identity',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'htlc-deliveries-')),path=join(dir,'operational.sqlite');let s=new Store(path);
 try{
  const f=await capture(s,[raw()],[at],{beforeCheckpoint:()=>{throw Error('Synthetic precommit failure');}});
  assert.equal(f.receipt.reason,'callback_error');assert.equal(count(s),0);assert.equal(s.one("SELECT count(*) n FROM canonical_observations WHERE kind='native_htlc'").n,0);
  const event=f.seen[0]!;const committed=f.collector.observe(event.value,event.at,{...f.origin,delivery:{adapterSession:event.origin.session,ordinal:event.origin.deliveryOrdinal!}});assert.equal(committed.accepted,true);assert.equal(count(s),1);
  const receiptId=receipts(s)[0].id,revision=nativeFailureRollups(s);assert.equal(revision.available,true);s.close();s=new Store(path);
  assert.equal(receipts(s)[0].id,receiptId);assert.equal(nativeFailureRollups(s,{through:revision.through}).revisionId,revision.revisionId);
  const second=await capture(s,[raw()],[later],{epoch:'new-epoch'});assert.equal(second.receipt.reason,'eof');assert.notEqual(second.receipt.session,f.receipt.session);assert.notEqual(second.origin.session,f.origin.session);assert.equal(count(s),2);
  assert.equal(second.collector.observe(event.value,later,{...f.origin,delivery:{adapterSession:event.origin.session,ordinal:event.origin.deliveryOrdinal!}}).reason,'session_mismatch');
  assert.ok(s.one("SELECT 1 FROM canonical_coverage WHERE status='gap' AND json_extract(details,'$.reason')='restart_without_replay'"));
  assert.equal(s.one('SELECT count(*) n FROM operations').n,0);
 }finally{s.close();rmSync(dir,{recursive:true});}
});
test('a new ordinal for an existing observation rolls back its receipt and checkpoint together before retry',async()=>{
 const s=new Store(':memory:');try{
  let attempted=0;const f=await capture(s,[raw(),raw()],[at,later],{beforeCheckpoint:()=>{if(++attempted===2)throw Error('Synthetic duplicate-observation precommit failure');}});
  assert.equal(f.receipt.reason,'callback_error');assert.equal(count(s),1);assert.equal(s.one("SELECT count(*) n FROM canonical_observations WHERE kind='native_htlc'").n,1);
  const checkpoint=s.one("SELECT details FROM canonical_coverage WHERE capability='htlc_epoch_checkpoint' ORDER BY rowid DESC LIMIT 1");assert.equal(JSON.parse(checkpoint.details).lastProcessingAt,at);
  const e=f.seen[1]!,retry=f.collector.observe(e.value,e.at,{...f.origin,delivery:{adapterSession:e.origin.session,ordinal:e.origin.deliveryOrdinal!}});assert.equal(retry.duplicate,true);assert.equal(count(s),2);assert.equal(s.one("SELECT count(*) n FROM canonical_observations WHERE kind='native_htlc'").n,1);
 }finally{s.close();}
});
test('per-delivery UTC day and cached diagnostic context survive identical failures after a contradictory forward',async()=>{
 const s=new Store(':memory:');try{
  const frames=[raw('forward'),raw('forward_fail'),raw('forward','4000'),raw('forward_fail')];
  const f=await capture(s,frames,[at,at,later,later]);assert.equal(f.receipt.reason,'eof');
  const failureReceipts=receipts(s).filter(r=>r.details.record.variant==='forward_fail');assert.equal(failureReceipts.length,2);assert.equal(failureReceipts[0].details.observationId,failureReceipts[1].details.observationId);
  const original=failureReceipts[0].details;assert.equal(original.originalEnvelope.processingAt,at);assert.equal(original.diagnosticContext.cachedForwardKnown,true);assert.equal(original.diagnosticContext.amountMsat,'3000');
  const contradictory=failureReceipts[1].details;assert.equal(contradictory.originalEnvelope.processingAt,later);assert.equal(contradictory.diagnosticContext.cachedForwardKnown,false);assert.equal(contradictory.diagnosticContext.cachedForwardReason,'cold_cache');assert.equal(contradictory.diagnosticContext.uncertainty,'contradictory_circuit');assert.equal(contradictory.diagnosticContext.amountMsat,null);assert.equal(contradictory.diagnosticContext.classification,'unknown');
  const rollup:any=nativeFailureRollups(s);assert.equal(rollup.rows.length,2);assert.deepEqual(rollup.rows.map((r:any)=>r.day),['2026-10-12','2026-10-13']);assert.equal(rollup.rows[0].deliveryCount,1);assert.equal(rollup.rows[1].unknownDiagnosticAmountDeliveryCount,1);assert.equal(rollup.rows[1].classificationDeliveryCounts.unknown,1);
  assert.equal(rollup.calculationVersion,NATIVE_DELIVERY_ROLLUP_VERSION);assert.equal(rollup.sourceHistoryComplete,false);assert.equal(rollup.rows[0].uniqueAttemptCount,null);
  assert.equal(s.one("SELECT count(*) n FROM canonical_projection_revisions WHERE name='native_htlc_diagnostics'").n,3);
 }finally{s.close();}
});
test('bounded immutable receipt-range continuations preserve all deliveries and explicit units without additive distinct counts or legacy coverage inflation',async()=>{
 const s=new Store(':memory:'),views=new EvidenceViews();try{
  const times=Array.from({length:65},(_,i)=>new Date(Date.parse(at)+i).toISOString());
  const f=await capture(s,Array.from({length:65},()=>raw()),times);assert.equal(f.receipt.reason,'eof');assert.equal(count(s),65);
  new CanonicalModel(s.db).appendCoverage({...binding,capability:'native_htlc_events',scope:'synthetic-old-counter',source:'lnd.htlc',epoch:'old',start:at,end:later,observedAt:later,status:'partial',details:{eventCount:999999}});
  const overview:any=s.stats().diagnostics.native;assert.equal(overview.collectionMetadata.failureRollups.count.unit,'receipt_range_bucket');assert.equal(overview.collectionMetadata.failureRollups.projectionLimits.limit,100);
  const first:any=canonicalDiagnostics(s,{provider:'native',collection:'failureRollups',limit:200});assert.equal(first.diagnostics.native.failureRollups[0].deliveryCount,32);assert.equal(first.projectionLimits.limit,200);assert.equal(first.projectionLimits.inputLimit,32);assert.equal(first.projectionLimits.selectedUnit,'receipt_range_buckets');assert.equal(first.projectionLimits.truncated,true);assert.equal(first.sourceMetadata.queryRangeExhausted,false);
  const revisionId=first.sourceMetadata.revisionId;
  await capture(s,[raw()],[later],{epoch:'later-subscription'});
  const pinned:any=canonicalDiagnostics(s,{provider:'native',collection:'failureRollups',limit:200,through:first.sourceMetadata.through});assert.equal(pinned.sourceMetadata.revisionId,revisionId);
  const seen=new Set<string>();let delivered=0,q:any={section:'diagnostics',provider:'native',collection:'failureRollups'};
  // Pin the original coverage range using the existing scope-bound source cursor.
  const source:any=evidenceSource(s,q);
  // evidenceSource uses the existing query hash, not canonical digest.
  const {hash,json}=await import('../domain.js');q={...q,sourceCursor:Buffer.from(json({scopeHash:hash(json(q)),after:0,through:first.sourceMetadata.through})).toString('base64url')};
  for(let n=0;n<20;n++){
   const page:any=views.page('delivery-fixture',evidenceSource(s,q),q);assert.ok(Buffer.byteLength(JSON.stringify(page))<=12000);const envelope=boundedEvidenceEnvelope(page,{phase:'research',remainingMs:1000});assert.ok(Buffer.byteLength(JSON.stringify(envelope.result))<=12000);
   assert.equal(page.summary.granularity,'committed_allowlisted_forward_callback_delivery');
   for(const row of page.rows){assert.equal(row.countScope,'this_immutable_receipt_range_only');assert.equal(row.distinctObservationCountInReceiptRange,1);assert.equal(row.eventMultiplicityQualified,false);assert.equal(row.semanticParityQualified,false);delivered+=row.deliveryCount;for(const id of row.sourceReceiptIds){assert.equal(seen.has(id),false);seen.add(id);}}
   if(!page.nextCall)break;q=page.nextCall.query;if(q.offset===0)views.release('delivery-fixture');
  }
  assert.equal(delivered,65);assert.equal(seen.size,65);assert.equal(source.sourceMetadata.distinctCountScope,'per_receipt_range_not_additive_across_revisions');
  assert.equal(s.one('PRAGMA user_version').user_version,7);
 }finally{views.release('delivery-fixture');s.close();}
});
test('unpinned failure rollups reuse one revision while unrelated coverage advances and fork for a new failure receipt',async()=>{
 const s=new Store(':memory:');try{await capture(s,[raw(),raw()]);const n=()=>Number(s.one("SELECT count(*) n FROM canonical_projection_revisions WHERE name='native_failure_delivery_rollups'").n);
 const first:any=nativeFailureRollups(s,{limit:100});assert.equal(n(),1);assert.equal(first.through,Number(s.one('SELECT max(rowid) n FROM canonical_coverage').n));
 for(let i=0;i<5;i++){new CanonicalModel(s.db).appendCoverage({...binding,capability:'native_htlc_events',scope:'unrelated-'+i,source:'lnd.htlc',epoch:'x',start:at,end:later,observedAt:later,status:'partial',details:{}});s.stats();assert.equal((nativeFailureRollups(s,{limit:100}) as any).revisionId,first.revisionId);}
 assert.equal(n(),1);await capture(s,[raw()],[later],{epoch:'later-subscription'});const next:any=nativeFailureRollups(s,{limit:100});assert.notEqual(next.revisionId,first.revisionId);assert.equal(next.rows.reduce((a:number,r:any)=>a+r.deliveryCount,0),3);assert.equal(n(),2);
 }finally{s.close();}
});
test('truncated unpinned rollup pages keep one revision while failure receipts keep arriving, and paging still reaches the new receipts',async()=>{
 const s=new Store(':memory:');try{
  await capture(s,Array.from({length:40},()=>raw()),Array.from({length:40},(_,i)=>new Date(Date.parse(at)+i).toISOString()));
  const n=()=>Number(s.one("SELECT count(*) n FROM canonical_projection_revisions WHERE name='native_failure_delivery_rollups'").n);
  const first:any=nativeFailureRollups(s,{limit:100});assert.equal(first.nextAfter!==null,true);assert.equal(first.rows.reduce((a:number,r:any)=>a+r.deliveryCount,0),32);assert.equal(n(),1);
  let latest:any=first;
  for(let i=0;i<10;i++){await capture(s,[raw()],[later],{epoch:'arrival-'+i});s.stats();latest=nativeFailureRollups(s,{limit:100});assert.equal(latest.revisionId,first.revisionId);assert.ok(latest.through>first.through);}
  assert.equal(n(),1);assert.equal(first.receiptRange.through,undefined);
  const pinned:any=nativeFailureRollups(s,{limit:100,through:first.through});assert.equal(pinned.revisionId,first.revisionId);assert.equal(pinned.through,first.through);
  const rest:any=nativeFailureRollups(s,{limit:100,after:latest.nextAfter,through:latest.through});assert.equal(rest.nextAfter,null);assert.equal(rest.rows.reduce((a:number,r:any)=>a+r.deliveryCount,0),18);
  const old:any=nativeFailureRollups(s,{limit:100,after:first.nextAfter,through:first.through});assert.equal(old.rows.reduce((a:number,r:any)=>a+r.deliveryCount,0),8);
 }finally{s.close();}
});

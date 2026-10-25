import type {Store} from './store.js';
import {CanonicalModel,digest} from './canonical-model.js';
import {channelScid} from './diagnostics.js';
import {HTLC_DELIVERY_CAPABILITY,HTLC_DELIVERY_SCHEMA} from './native-htlc.js';
import type {CanonicalReadQuery} from './canonical-consumers.js';

export const NATIVE_DELIVERY_ROLLUP_VERSION='native-htlc-delivery-receipt-range-v1';
// Each immutable revision covers this finite receipt range. Repeated buckets across
// revisions must retain their ranges; distinct-observation counts are not additive.
export const DELIVERY_ROLLUP_INPUT_LIMIT=32;
export function nativeFailureRollups(store:Store,q:CanonicalReadQuery={}){
 const after=q.after??0,limit=q.limit??200;
 const filters=["capability=?","status='partial'","json_extract(details,'$.schema')=?","json_extract(details,'$.record.variant') IN ('link_fail','forward_fail')"],args:any[]=[HTLC_DELIVERY_CAPABILITY,HTLC_DELIVERY_SCHEMA];
 for(const key of ['start','end'] as const)if(q[key]){if(!Number.isFinite(Date.parse(q[key]!)))throw Error('Invalid delivery interval');filters.push('observed_at'+(key==='start'?'>=':'<')+'?');args.push(new Date(q[key]!).toISOString());}
 if(q.start&&q.end&&Date.parse(q.start)>Date.parse(q.end))throw Error('Inverted delivery interval');
 for(const key of ['source','target'] as const)if(q[key]){filters.push("json_extract(details,'$."+(key==='source'?'sourceChannel':'targetChannel')+"')=?");args.push(channelScid(q[key]));}
 if(q.channel){filters.push("(json_extract(details,'$.sourceChannel')=? OR json_extract(details,'$.targetChannel')=?)");args.push(channelScid(q.channel),channelScid(q.channel));}
 // An unpinned range ends at the newest matching receipt, not the coverage high-water:
 // unrelated coverage appends would otherwise fork an identical revision on every read.
 const through=q.through??Math.max(after,Number(store.one('SELECT coalesce(max(rowid),0) n FROM canonical_coverage WHERE '+filters.join(' AND '),...args).n));
 if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(through)||through<after||!Number.isSafeInteger(limit)||limit<1||limit>10000)throw Error('Bounded native delivery range required');
 filters.unshift('rowid>?','rowid<=?');args.unshift(after,through);
 const inputLimit=Math.min(limit,DELIVERY_ROLLUP_INPUT_LIMIT),selected=store.all('SELECT rowid cursor,* FROM canonical_coverage WHERE '+filters.join(' AND ')+' ORDER BY rowid LIMIT ?',...args,inputLimit+1),receipts=selected.slice(0,inputLimit);
 if(!receipts.length)return {available:false,rows:null,nextAfter:null,through,note:'No committed native failure delivery receipts in this range; historical absence remains unknown',sourceHistoryComplete:false};
 const nextAfter=selected.length>inputLimit?Number(receipts.at(-1)!.cursor):null;
 const range={after,through,lastReceipt:Number(receipts.at(-1)!.cursor)},scope=digest({source:q.source??null,target:q.target??null,channel:q.channel??null,start:q.start??null,end:q.end??null}),epoch=digest({scope,range,inputLimit,limit});
 const prior=store.one('SELECT id,result FROM canonical_projection_revisions WHERE name=? AND scope=? AND epoch=? AND calculation_version=?','native_failure_delivery_rollups',scope,epoch,NATIVE_DELIVERY_ROLLUP_VERSION);
 if(prior)return {...JSON.parse(prior.result),revisionId:prior.id};
 const buckets=new Map<string,any>(),observationSets=new Map<string,Set<string>>();
 for(const receipt of receipts){
  const d=JSON.parse(receipt.details),r=d.record,c=d.diagnosticContext;
  const identity={nodeId:receipt.node_id,network:receipt.network,sourceVersion:d.binding.sourceVersion,sourceInstance:d.binding.sourceInstance,epoch:receipt.epoch,collectorSession:d.collectorSession,adapterSession:d.adapterSession,day:d.originalEnvelope.processingAt.slice(0,10),source:d.sourceChannel,target:d.targetChannel},key=digest(identity);
  let b=buckets.get(key);if(!b){b={id:digest({epoch,key}),...identity,countUnit:'committed_allowlisted_forward_callback_delivery',countScope:'this_immutable_receipt_range_only',receiptRange:range,linkFailDeliveryCount:0,forwardFailDeliveryCount:0,deliveryCount:0,distinctObservationCountInReceiptRange:0,classificationDeliveryCounts:{liquidity:0,other:0,downstream_failure:0,unknown:0},knownDiagnosticAmountMsatInReceiptRange:'0',amountMeaning:'per_delivery_diagnostic_amounts_not_settled_value_or_demand',unknownDiagnosticAmountDeliveryCount:0,converterDroppedDeliveryCount:0,precisionDifferenceDeliveryCount:0,precisionUnknownDeliveryCount:0,sourceReceiptIds:[],sourceObservationIds:[],sourceHistoryComplete:false,eventMultiplicityQualified:false,uniqueAttemptCount:null,uniquePaymentCount:null,semanticParityQualified:false,financialAuthority:false};buckets.set(key,b);observationSets.set(key,new Set());}
  b.deliveryCount++;if(r.variant==='link_fail')b.linkFailDeliveryCount++;else b.forwardFailDeliveryCount++;
  const classification=['liquidity','other','downstream_failure'].includes(c.classification)?c.classification:'unknown';b.classificationDeliveryCounts[classification]++;
  if(c.amountMsat===null)b.unknownDiagnosticAmountDeliveryCount++;else b.knownDiagnosticAmountMsatInReceiptRange=(BigInt(b.knownDiagnosticAmountMsatInReceiptRange)+BigInt(c.amountMsat)).toString();
  if(c.converterDropReasons.length)b.converterDroppedDeliveryCount++;
  if(c.precisionDifference===true)b.precisionDifferenceDeliveryCount++;if(c.precisionDifference===null)b.precisionUnknownDeliveryCount++;
  b.sourceReceiptIds.push(receipt.id);observationSets.get(key)!.add(d.observationId);
 }
 for(const [key,b] of buckets){b.sourceObservationIds=[...observationSets.get(key)!];b.distinctObservationCountInReceiptRange=b.sourceObservationIds.length;}
 const rows=[...buckets.values()],result={available:true,rowUnit:'receipt_range_bucket',rows,nextAfter,through,receiptRange:range,countUnit:'committed_allowlisted_forward_callback_delivery',distinctCountScope:'per_receipt_range_not_additive_across_revisions',calculationVersion:NATIVE_DELIVERY_ROLLUP_VERSION,queryRangeExhausted:nextAfter===null,sourceHistoryComplete:false,complete:false,eventMultiplicityQualified:false,replayQualified:false,semanticParityQualified:false,financialAuthority:false,coverage:{complete:false,sourceHistoryComplete:false,note:'Committed delivery receipts only; pre-receipt history, reconnect gaps and unique attempts/payments remain unknown'},projectionLimits:{selected:rows.length,selectedUnit:'receipt_range_buckets',limit,inputLimit,selectedDeliveryReceipts:receipts.length,truncated:nextAfter!==null,upstreamHistoryComplete:false}};
 // Receipt coverage includes the original per-delivery context and observation ref.
 // Current observation links cannot rewrite this historical revision's inputs.
 const revisionId=new CanonicalModel(store.db).publishProjection({name:'native_failure_delivery_rollups',scope,epoch,calculationVersion:NATIVE_DELIVERY_ROLLUP_VERSION,observationIds:[],coverageIds:receipts.map(r=>r.id),result});
 return {...result,revisionId};
}

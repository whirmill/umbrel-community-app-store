import {readFileSync} from 'node:fs';
const SHAPE='f12ae61382e1eff131904419106c3ddb51d30f2443990443ed65c848de419682';
export function satDecimalToMsat(value:unknown):string {
  const s=typeof value==='number'&&Number.isFinite(value)?String(value):value;
  if(typeof s!=='string')throw new Error('Missing sat amount');
  const m=/^(\d+)(?:\.(\d{1,3}))?$/.exec(s);if(!m)throw new Error('Invalid sat amount precision');
  return (BigInt(m[1]!)*1000n+BigInt((m[2]??'').padEnd(3,'0'))).toString();
}
function integer(value:unknown):string {
  const s=typeof value==='number'&&Number.isSafeInteger(value)?String(value):value;
  if(typeof s!=='string'||!/^\d+$/.test(s))throw new Error('Invalid integer');return BigInt(s).toString();
}
export function channelScid(value:unknown):string {
  if(typeof value!=='string')throw new Error('Missing SCID');
  if(/^\d+x\d+x\d+$/.test(value)){
    const [height,tx,out]=value.split('x').map(BigInt);if(height!>0xffffffn||tx!>0xffffffn||out!>0xffffn)throw new Error('SCID out of range');return [height,tx,out].join('x');
  }
  const n=BigInt(integer(value));if(n>0xffffffffffffffffn)throw new Error('SCID out of range');return [n>>40n,(n>>16n)&0xffffffn,n&0xffffn].join('x');
}
function rows(value:unknown):any[]{if(!Array.isArray(value)||value.length>100000)throw new Error('Missing or unbounded source records');return value;}
function stamp(value:unknown):string {
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT.*Z$/.test(value)||!Number.isFinite(Date.parse(value)))throw new Error('Timestamp must be UTC');return value;
}
export interface DiagnosticProvider {status:'qualified'|'unavailable'|'incompatible';version?:string;reason?:string;capturedAt?:string;coverage?:unknown;forwards?:unknown[];failures?:unknown[];failureRollups?:unknown[];rebalances?:unknown[];}
function provider(raw:any,name:'lndg'|'lightningMate',capturedAt:string):DiagnosticProvider {
  if(raw?.status==='incompatible')return {status:'incompatible',version:typeof raw.version==='string'?raw.version:undefined,reason:'Source version or schema is not supported'};
  if(!raw||raw.status!=='ok')return {status:'unavailable',reason:'Capture unavailable; unknown is not zero'};
  try{
    if(raw.version!==(name==='lndg'?'1.11.1':'0.7.7'))throw new Error('Unsupported adapter version');
    const c=raw.coverage;if(!c||typeof c.complete!=='boolean'||typeof c.source!=='string')throw new Error('Missing explicit coverage');
    const start=stamp(c.start),end=stamp(c.end);if(start>end)throw new Error('Inverted coverage');
    const coverage={start,end,complete:c.complete,source:c.source,note:typeof c.note==='string'?c.note:''};
    if(name==='lndg'){
      if(raw.schemaFingerprint!==SHAPE)throw new Error('Selected-table schema mismatch');
      return {status:'qualified',version:raw.version,capturedAt,coverage,
        forwards:rows(raw.forwards).map(r=>({id:'lndg:'+integer(r.id),at:stamp(r.at),source:integer(r.chan_id_in),target:integer(r.chan_id_out),amountMsat:integer(r.amt_out_msat),feeMsat:satDecimalToMsat(r.fee),authority:'diagnostic; LND is authoritative'})),
        failures:rows(raw.failures).map(r=>({id:'lndg-failure:'+integer(r.id),at:stamp(r.at),source:integer(r.chan_id_in),target:integer(r.chan_id_out),amountMsat:(BigInt(integer(r.amount))*1000n).toString(),missedFeeMsat:satDecimalToMsat(r.missed_fee),failure:integer(r.failure_detail),wireFailure:integer(r.wire_failure),distinctPaymentsUnknown:true})),
        failureRollups:rows(raw.failureRollups).map(r=>({day:stamp(r.at).slice(0,10),source:integer(r.chan_id_in),target:integer(r.chan_id_out),count:integer(r.htlc_count),amountMsat:(BigInt(integer(r.amount_sum))*1000n).toString(),missedFeeMsat:satDecimalToMsat(r.fee_sum),granularity:'daily bucket; not event identities'})),
        rebalances:rows(raw.rebalances).map(r=>({id:'lndg-rebalance:'+integer(r.id),status:integer(r.status),succeeded:String(r.status)==='2',amountMsat:(BigInt(integer(r.value))*1000n).toString(),feeMsat:r.fees==null?null:satDecimalToMsat(r.fees),actualCorridorUnknown:true}))};
    }
    return {status:'qualified',version:raw.version,capturedAt,coverage,
      failures:rows(raw.failures).map(r=>({day:stamp(r.at).slice(0,10),target:channelScid(r.target),count:integer(r.liquidityCount),amountMsat:(BigInt(integer(r.liquiditySats))*1000n).toString(),otherCount:integer(r.otherCount),granularity:'daily outgoing-channel bucket',distinctPaymentsUnknown:true})),
      rebalances:rows(raw.rebalances).map(r=>{
        const fee=satDecimalToMsat(r.feeSats);if(r.feeMsatExact!=null&&integer(r.feeMsatExact)!==fee)throw new Error('Rebalance fee precision conflict');
        if(typeof r.status!=='string')throw new Error('Missing rebalance outcome');
        return {at:stamp(r.at),source:channelScid(r.sourceId),target:channelScid(r.targetId),amountMsat:(BigInt(integer(r.amountSats))*1000n).toString(),feeMsat:fee,status:r.status,imported:r.imported===true,financialAuthority:false};
      })};
  }catch(e){return {status:'incompatible',version:typeof raw.version==='string'?raw.version:undefined,reason:e instanceof Error?e.message:'Adapter validation failed'};}
}
export function qualifyDiagnostics(raw:any,identity:string,at=new Date().toISOString()) {
  const unavailable=()=>({at,lndg:{status:'unavailable',reason:'Projection missing, stale or node mismatch'} as DiagnosticProvider,lightningMate:{status:'unavailable',reason:'Projection missing, stale or node mismatch'} as DiagnosticProvider});
  if(raw?.schema!==1||raw.identity!==identity)return unavailable();
  try{const capturedAt=stamp(raw.capturedAt),age=Date.parse(at)-Date.parse(capturedAt);if(age<0||age>90000)return unavailable();return {at,lndg:provider(raw.providers?.lndg,'lndg',capturedAt),lightningMate:provider(raw.providers?.lightningMate,'lightningMate',capturedAt)};}catch{return unavailable();}
}
export function readDiagnostics(path:string|undefined,identity:string){try{if(!path)throw new Error('Not configured');return qualifyDiagnostics(JSON.parse(readFileSync(path,'utf8')),identity);}catch{return qualifyDiagnostics(null,identity);}}

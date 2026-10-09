import {readFileSync} from 'node:fs';
import {type Snapshot,integer} from './domain.js';

function amount(value:unknown):string{
  if(typeof value!=='string'||!/^\d+$/.test(value))throw new Error('Missing exact graph integer');return integer(value).toString();
}
function key(value:unknown):string{
  if(typeof value!=='string'||!/^0[23][0-9a-f]{64}$/.test(value))throw new Error('Invalid graph public identity');return value;
}
export function announcedFee(baseMsat:string,ppm:string,amountMsat:string):string{
  return (integer(baseMsat)+(integer(amountMsat)*integer(ppm)+999999n)/1000000n).toString();
}
/** Announced direct-hop price distribution, never proof of executable routes. */
export function qualifyCompetition(raw:any,snapshot:Snapshot,at=new Date().toISOString()){
  const unavailable=(reason:string)=>({status:'unavailable',at,reason,channels:[]});
  if(raw?.schema!==1||raw.identity!==snapshot.identity||raw.version!=='0.21.3-beta')return unavailable('Graph source, version or node binding unavailable');
  const age=Date.parse(at)-Date.parse(raw.capturedAt);
  if(!Number.isFinite(age)||age<0||age>300000||!Array.isArray(raw.peers)||raw.peers.length>16)return unavailable('Graph capture stale, missing or unbounded');
  try{
    const peers=new Map<string,any>();
    for(const p of raw.peers){const peer=key(p.peer);if(peers.has(peer))throw new Error('Duplicate peer capture');peers.set(peer,p);}
    const channels=snapshot.channels.map(channel=>{
      const p=peers.get(channel.peer);if(p?.status!=='ok')return {id:channel.id,alias:channel.alias,status:'unavailable',reason:'Peer graph capture unavailable'};
      if(typeof p.captureComplete!=='boolean'||!Array.isArray(p.policies)||p.policies.length>10000||p.liquidityKnown!==false||p.trafficKnown!==false)throw new Error('Graph coverage mismatch');
      const capturedAt=p.capturedAt??raw.capturedAt,peerAge=Date.parse(at)-Date.parse(capturedAt);
      if(!Number.isFinite(peerAge)||peerAge<0||peerAge>300000)return {id:channel.id,alias:channel.alias,status:'unavailable',reason:'Peer acquisition stale'};
      if(!Number.isSafeInteger(p.capturedChannels)||p.capturedChannels<0||!Number.isSafeInteger(p.missingPolicies)||p.missingPolicies<0||p.missingPolicies>p.capturedChannels)throw new Error('Graph count shape mismatch');
      const seen=new Set<string>();
      const policies=p.policies.map((r:any)=>{
        const id=amount(r.channelId);if(seen.has(id))throw new Error('Duplicate graph channel');seen.add(id);
        if(typeof r.disabled!=='boolean')throw new Error('Missing graph disable flag');
        const neighbor=key(r.neighbor);if(neighbor===snapshot.identity)throw new Error('Our policy included among competitors');
        return {id,neighbor,capacitySat:amount(r.capacitySat),baseMsat:amount(r.baseMsat),ppm:amount(r.ppm),minMsat:amount(r.minMsat),maxMsat:amount(r.maxMsat),disabled:r.disabled,lastUpdate:amount(r.lastUpdate)};
      });
      const quotes=['10000','100000','500000'].map(sat=>{
        const msat=(BigInt(sat)*1000n).toString();
        const eligible=policies.filter((p:any)=>!p.disabled&&BigInt(p.minMsat)<=BigInt(msat)&&BigInt(p.maxMsat)>=BigInt(msat)&&BigInt(p.capacitySat)>=BigInt(sat)&&BigInt(p.lastUpdate)*1000n<=BigInt(Date.parse(raw.capturedAt)));
        const values=eligible.map((p:any)=>BigInt(announcedFee(p.baseMsat,p.ppm,msat))).sort((a:bigint,b:bigint)=>a<b?-1:a>b?1:0);
        const own=announcedFee(channel.baseMsat,String(channel.ppm),msat);
        const percentile=(fraction:number)=>values.length?values[Math.floor((values.length-1)*fraction)]!.toString():null;
        return {amountSat:sat,announcedEligible:values.length,ourFeeMsat:own,ourActive:channel.active,
          lowerQuartileFeeMsat:percentile(.25),medianFeeMsat:percentile(.5),upperQuartileFeeMsat:percentile(.75),
          cheaperThanUs:values.filter((v:bigint)=>v<BigInt(own)).length,executionLiquidityUnknown:true};
      });
      return {id:channel.id,alias:channel.alias,peer:channel.peer,status:p.captureComplete&&p.missingPolicies===0?'qualified':'partial',capturedAt,
        graphChannelCount:amount(p.declaredChannels),capturedChannels:p.capturedChannels,missingPolicies:p.missingPolicies,
        disabledPolicies:policies.filter((p:any)=>p.disabled).length,quotes,
        alternatives:policies.filter((p:any)=>!p.disabled).slice(0,100),alternativesTruncated:policies.filter((p:any)=>!p.disabled).length>100,
        note:'Public neighbor-to-peer policies; balances and rival traffic unknown. Price does not prove demand or profitability.'};
    });
    return {status:'qualified',at,capturedAt:raw.capturedAt,version:1,channels,
      coverage:'Current public graph only; no rival forwarding history or liquidity. Missing peers and policies remain explicit.'};
  }catch{return unavailable('Graph format incompatible; price comparison unknown');}
}
export function readCompetition(path:string|undefined,snapshot:Snapshot){
  try{if(!path)throw new Error('Not configured');return qualifyCompetition(JSON.parse(readFileSync(path,'utf8')),snapshot);}
  catch{return qualifyCompetition(null,snapshot);}
}

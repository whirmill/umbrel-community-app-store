import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.js';
import { now,hash,json,integer,type Snapshot } from './domain.js';
import { readDiagnostics } from './diagnostics.js';
import { readCompetition } from './competition.js';
import { evaluate } from './economics.js';
import { Executor } from './executor.js';
import type { NodeClient } from './lnd.js';

/** Explicit config formats; unknown layouts fail closed, never mean OFF. */
export function checkInterlocks(paths:{lightningMate:string;lndg:string}) {
  const config=JSON.parse(readFileSync(paths.lightningMate,'utf8'));
  const keys=['fee','rebalance','channel','sell','autoclose','relist','reprice','size','maxHTLC'];
  // Deployment provides a reviewed projection of the live settings via a read-only gate file.
  if(config.schema!==1 || !Number.isFinite(Date.parse(config.at)) || Date.parse(config.at)>Date.now() || Date.now()-Date.parse(config.at)>90000 || keys.some(k=>config[k]!==false) || config.lsp!==false || config.lndgAF!==false || config.lndgAR!==false || config.lndgAutopilot!==false || config.loop!==false) return {ok:false,at:now(),reason:'Other automation settings unknown, enabled or stale'};
  return {ok:true,at:now(),reason:'Live operator interlock verified',source:paths.lightningMate};
}
export class Collector {
  busy=false;
  constructor(private store:Store,private node:NodeClient,private executor:Executor,private gateFile:string){}
  async collect() {
    if(this.busy)return;this.busy=true;
    try {
      this.store.set('automationProof',checkInterlocks({lightningMate:this.gateFile,lndg:''}));
      await this.executor.reconcile();
      const s=await this.node.snapshot();if(s.identity!==this.store.get('expectedIdentity'))throw new Error('Node identity mismatch');const previous=this.store.get<Snapshot>('snapshot');
      for(const c of s.channels) {
        const old=previous?.channels.find(x=>x.id===c.id);
        const pending=this.store.one("SELECT id FROM operations WHERE state IN ('sending','uncertain') AND json_extract(details,'$.snapshot.channels') IS NOT NULL");
        if(old && (old.ppm!==c.ppm||old.baseMsat!==c.baseMsat) && !pending) {
          this.store.run('INSERT OR REPLACE INTO channel_holds VALUES(?,?,?,?)',c.id,now(),'Manual policy change',s.at);
          this.store.event({id:hash('manual:'+c.id+s.at),at:s.at,type:'manual_policy',source:c.id,target:c.id,amountMsat:'0',feeMsat:'0',pinned:true,details:{before:{base:old.baseMsat,ppm:old.ppm},after:{base:c.baseMsat,ppm:c.ppm}}});
        } else if(old && this.store.one('SELECT channel_id FROM channel_holds WHERE channel_id=?',c.id) && old.ppm===c.ppm && old.baseMsat===c.baseMsat && c.pendingSat==='0') this.store.run('DELETE FROM channel_holds WHERE channel_id=?',c.id);
      }
      this.store.saveSnapshot(s);
      this.store.set('diagnostics',readDiagnostics(process.env.DIAGNOSTICS_FILE,s.identity));
      this.store.set('competition',readCompetition(process.env.COMPETITION_FILE,s));
      const start=this.store.get('historyStart')??'2026-09-25T00:36:45Z',end=now();
      const payments=await this.node.payments();
      // Project only circular settled payments: no personal invoices, destinations or preimages.
      for(const p of payments){
        if(p.status!=='SUCCEEDED')continue;
        const routes=(p.htlcs??[]).filter((h:any)=>h.status==='SUCCEEDED').map((h:any)=>h.route);
        if(!routes.length || routes.some((r:any)=>r.hops?.at(-1)?.pub_key!==s.identity))continue;
        if(this.store.one('SELECT id FROM operations WHERE payment_hash=?',p.payment_hash))continue;
        const at=new Date(Number(BigInt(p.creation_time_ns??'0')/1000000n)).toISOString();if(at<start)continue;
        const source=String(routes[0].hops[0].chan_id),target=String(routes[0].hops.at(-1).chan_id);
        const historicalRows=this.store.all("SELECT id,amount_msat,details FROM ledger WHERE classification='expense'").filter(r=>{const d=JSON.parse(r.details);return r.id==='rebalance-'+p.payment_hash || [d.paymentHash,d.payment_hash,d.evidence?.paymentHash,d.evidence?.payment_hash].includes(p.payment_hash);});
        const historical=historicalRows.length===1;
        if(historical && historicalRows[0].amount_msat!==String(p.fee_msat))throw new Error('Historical fee discrepancy: correction required');
        if(historicalRows.length>1)throw new Error('Duplicate historical payment attribution');
        if(!historical)this.store.ledger({id:'manual:'+p.payment_hash,at,classification:'expense',amountMsat:String(p.fee_msat),category:'manual_rebalance',details:{paymentHash:p.payment_hash,source,target}});
        const eventId='manual:'+p.payment_hash;
        if(!this.store.one('SELECT id FROM events WHERE id=?',eventId)&&at>=(this.store.get('installedAt')??now())) {
          for(const c of [source,target])this.store.run('INSERT OR REPLACE INTO channel_holds VALUES(?,?,?,?)',c,now(),'Manual payment under reconciliation',s.at);
        }
        this.store.event({id:eventId,at,type:'manual_operation',source,target,amountMsat:String(p.value_msat),feeMsat:String(p.fee_msat),pinned:true,details:{paymentHash:p.payment_hash,index:p.payment_index}});
      }
      const forwards=await this.node.forwards(Math.floor(Date.parse(start)/1000),Math.floor(Date.parse(end)/1000));
      const seen=new Map<string,number>();
      this.store.tx(()=>{
        for(const e of forwards) {
          const at=e.timestamp_ns?new Date(Number(BigInt(e.timestamp_ns)/1000000n)).toISOString():new Date(Number(e.timestamp)*1000).toISOString();
          const key=hash(json([e.timestamp_ns??e.timestamp,e.chan_id_in,e.chan_id_out,e.amt_in_msat,e.amt_out_msat,e.fee_msat]));const occurrence=seen.get(key)??0;seen.set(key,occurrence+1);
          this.store.event({id:'fwd:'+key+':'+occurrence,at,type:'external_forward',source:String(e.chan_id_in),target:String(e.chan_id_out),amountMsat:String(e.amt_out_msat),feeMsat:String(e.fee_msat),details:{source:'LND forwardinghistory',timestampPrecision:e.timestamp_ns?'ns':'s'}});
          this.store.ledger({id:'fwd:'+key+':'+occurrence,at,classification:'revenue',amountMsat:String(e.fee_msat),category:'routing'});
        }
        this.store.run('INSERT OR REPLACE INTO coverage VALUES(?,?,?,?,?,?)','forwards',start,end,'LND forwards',1,json({pagesComplete:true,events:forwards.length}));
      });
      evaluate(this.store,end);this.store.retain();
      const blockers:string[]=[];if(this.store.get('integrityBlocker'))blockers.push(this.store.get<string>('integrityBlocker')!);
      if(this.store.get('importReport')?.problems?.length)blockers.push('Historical import discrepancies unresolved');
      if(!s.synced)blockers.push('LND not synchronized');
      if(!this.store.get('historicalLedgerImported'))blockers.push('Historical ledger not imported');
      if(this.store.get('automationProof')?.ok!==true)blockers.push('Live automation interlock unavailable');
      if(integer(s.confirmedSat)<500000n)blockers.push('Protected reserve below 500,000 sat');
      this.store.set('bootstrapReady',!blockers.length);this.store.set('blockers',blockers);this.store.set('collector',{at:now(),ok:true});
    }catch{this.store.set('bootstrapReady',false);this.store.set('collector',{at:now(),ok:false,error:'Collection/reconciliation failed; no new AI action'});}finally{this.busy=false;}
  }
  async stream(signal:AbortSignal){
    const start=now();try{await this.node.htlc(e=>{
      if(!e.timestamp_ns)return;
      const at=new Date(Number(BigInt(e.timestamp_ns)/1000000n)).toISOString();
      this.store.event({id:'htlc:'+hash(json(e)),at,type:e.link_fail_event?'htlc_rejected':'htlc_event',source:String(e.incoming_channel_id??''),target:String(e.outgoing_channel_id??''),amountMsat:String(e.link_fail_event?.info?.outgoing_amt_msat??e.forward_event?.info?.outgoing_amt_msat??'0'),feeMsat:'0',details:{source:'LND SubscribeHtlcEvents',failure:e.link_fail_event?.failure_detail??null,wireFailure:e.link_fail_event?.wire_failure??null}});
    },signal);}finally{this.store.run('INSERT INTO coverage VALUES(?,?,?,?,?,?)',hash(start),start,now(),'HTLC stream',0,json({note:'Live segment; gaps/reconnect boundaries retained, no historical failure completeness asserted'}));}
  }
}

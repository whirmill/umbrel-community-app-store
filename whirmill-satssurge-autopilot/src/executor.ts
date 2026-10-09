import { Store } from './store.js';
import { forecast } from './economics.js';
import { hash, json, now, integer, terminal, type Proposal, type Snapshot, type PaymentOutcome } from './domain.js';
import type { NodeClient } from './lnd.js';

export class Executor {
  constructor(private store:Store,private node:NodeClient){}
  private executing=false;
  private dispatchGuard(operation:string,snapshot?:Snapshot) {
    try{if(snapshot)this.store.assertReservedDispatch(operation,snapshot);else this.store.assertDispatchReady();}catch(error){this.finish(operation,{status:'FAILED',feeMsat:'0',amountSat:'0'});throw error;}
  }
  async execute(p:Proposal) {
    if(this.executing)throw new Error('Executor busy');this.executing=true;
    try{return await this.dispatch(p);}finally{this.executing=false;}
  }
  private async dispatch(p:Proposal) {
    // Revalidation happens before the irreversible intent. Model-provided benefit is never used.
    p.demandKey=p.kind==='rebalance'?`${p.source}->${p.target}`:`fee:${p.target}`;
    const s=await this.node.snapshot();
    const known=this.store.get<Snapshot>('snapshot');
    for(const channel of s.channels){
      const old=known?.channels.find(c=>c.id===channel.id);
      if(old && (old.ppm!==channel.ppm || old.baseMsat!==channel.baseMsat)) {
        this.store.run('INSERT OR REPLACE INTO channel_holds VALUES(?,?,?,?)',channel.id,now(),'Policy changed externally',s.at);
        throw new Error('External fee change: reconcile and replan');
      }
    }
    const f=forecast(this.store,p,s),{decision,operation}=this.store.reserve(p,f,s);
    this.store.set('fingerprint:'+decision,hash(json(p.evidenceIds.slice().sort())));
    this.store.run('UPDATE events SET pinned=1 WHERE id IN ('+p.evidenceIds.map(()=>'?').join(',')+')',...p.evidenceIds);
    try {
      // Recheck pause immediately before any writable RPC. No await between check and dispatch.
      this.dispatchGuard(operation);
      if(p.kind==='fee_change') {
        const c=s.channels.find(c=>c.id===p.target)!;
        this.store.run("UPDATE operations SET state='sending' WHERE id=?",operation);
        this.dispatchGuard(operation,s);
        await this.node.updateFee(c,p.newPpm!);
        const verified=await this.node.snapshot(),after=verified.channels.find(x=>x.id===c.id);
        if(!after || after.ppm!==p.newPpm || after.baseMsat!==c.baseMsat) throw new Error('Policy not yet verified; reconcile');
        this.store.saveSnapshot(verified);
        this.finish(operation,{status:'SUCCEEDED',feeMsat:'0',amountSat:'0'});
      } else {
        this.store.run("UPDATE operations SET state='preparing' WHERE id=?",operation);
        this.dispatchGuard(operation);
        const invoice=await this.node.invoice(p.amountSat,`SatsSurge:${operation}`);
        // A crash here may leave an unused invoice, but never permits a duplicate send.
        this.store.run("UPDATE operations SET payment_hash=?,invoice=?,state='sending' WHERE id=?",invoice.hash,invoice.request,operation);
        const fresh=await this.node.snapshot();
        const changed=[p.source,p.target].some(key=>{const before=s.channels.find(c=>c.id===key)!,after=fresh.channels.find(c=>c.id===key);const drift=(a:string,b:string)=>{const d=integer(a)-integer(b);return (d<0n?-d:d)*100n>integer(before.capacitySat);};return !after||!after.active||after.ppm!==before.ppm||after.baseMsat!==before.baseMsat||after.pendingSat!=='0'||drift(after.localSat,before.localSat)||drift(after.remoteSat,before.remoteSat);});
        if(changed || fresh.identity!==s.identity || !fresh.synced || integer(fresh.confirmedSat)<500000n || Date.now()-Date.parse(this.store.get('automationProof')?.at??'1970-01-01')>90000){this.finish(operation,{status:'FAILED',feeMsat:'0',amountSat:'0'});this.store.saveSnapshot(fresh);throw new Error('Material state change before send; replan');}
        this.dispatchGuard(operation,fresh);
        const result=await this.node.send(invoice.request,p.source,s.channels.find(c=>c.id===p.target)!.peer,p.maxFeeMsat);
        this.finish(operation,result);
      }
      return {decision,operation,state:this.store.one('SELECT state FROM operations WHERE id=?',operation).state};
    }catch(e){
      const state=this.store.one('SELECT state FROM operations WHERE id=?',operation).state;
      if(!terminal(state))this.store.run("UPDATE operations SET state='uncertain',details=? WHERE id=?",json({snapshot:s,error:'RPC interrupted or verification incomplete; no replay',needsReconciliation:true}),operation);
      throw e;
    }
  }
  finish(operation:string,result:PaymentOutcome) {
    const op=this.store.one('SELECT * FROM operations WHERE id=?',operation);
    const d=this.store.one('SELECT * FROM decisions WHERE id=?',op.decision_id),p=JSON.parse(d.proposal) as Proposal;
    if(terminal(op.state))return;
    if(!terminal(result.status)){this.store.run("UPDATE operations SET state='in_flight' WHERE id=?",operation);return;}
    if(result.status==='SUCCEEDED' && p.kind==='rebalance' && (result.source!==p.source || result.target!==p.target || result.amountSat!==p.amountSat || integer(result.feeMsat)>integer(p.maxFeeMsat))) {
      this.store.set('enabled',false);this.store.set('integrityBlocker','Payment endpoint/amount/cost invariant violated; audited operator review required');this.store.set('blockers',[this.store.get('integrityBlocker')]);
      // Still account actual settled fee. Never hide a cost just because an invariant failed.
    }
    const completedAt=now();
    this.store.tx(()=>{
      this.store.ledger({id:'op:'+operation,at:completedAt,classification:'expense',amountMsat:result.status==='SUCCEEDED'?result.feeMsat:'0',category:p.category,operationId:operation,details:{paymentHash:op.payment_hash,status:result.status}});
      this.store.run('UPDATE operations SET state=?,invoice=NULL,details=? WHERE id=?',result.status,json({...result,completedAt}),operation);
      this.store.run('UPDATE reservations SET active=0 WHERE operation_id=?',operation);
      this.store.run('UPDATE decisions SET status=? WHERE id=?',result.status==='SUCCEEDED'?'observing':'failed',d.id);
    });
  }
  async reconcile() {
    if(this.executing)return;
    this.executing=true;try {
    for(const op of this.store.all("SELECT * FROM operations WHERE state IN ('reserved','preparing','sending','uncertain','in_flight')")) {
      const d=this.store.one('SELECT proposal FROM decisions WHERE id=?',op.decision_id),p=JSON.parse(d.proposal) as Proposal;
      if(op.payment_hash){try{const r=await this.node.track(op.payment_hash);if(r)this.finish(op.id,r);}catch{/* Not found/timeout cannot prove failure. */}}
      else if(p.kind==='fee_change' && ['sending','uncertain'].includes(op.state)) {
        const s=await this.node.snapshot(),c=s.channels.find(c=>c.id===p.target);
        const original=JSON.parse(op.details)?.snapshot?.channels?.find((x:any)=>x.id===p.target);
        if(c && c.ppm===p.newPpm && original && c.baseMsat===original.baseMsat){this.store.saveSnapshot(s);this.finish(op.id,{status:'SUCCEEDED',feeMsat:'0',amountSat:'0'});}
      } else if(op.state==='reserved' || (['preparing','uncertain'].includes(op.state) && p.kind==='rebalance' && !op.payment_hash)) {
        // The dispatch marker was never written; no RPC could have occurred.
        this.finish(op.id,{status:'FAILED',feeMsat:'0',amountSat:'0'});
      }
    }
    }finally{this.executing=false;}
  }
}

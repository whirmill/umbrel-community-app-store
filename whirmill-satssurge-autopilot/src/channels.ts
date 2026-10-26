import type { Store } from './store.js';
import type { NodeClient, ChannelRpc } from './lnd.js';
import { channelCandidate } from './channel-measurement.js';
import { id, now, json, hash, integer, month, channelKind, CHANNEL_MANDATE, type ChannelProposal, type Snapshot } from './domain.js';

export type ChannelState = 'reserved'|'sending'|'uncertain'|'pending'|'confirmed'|'failed';
export interface ChannelOperation {
  id:string; proposalId:string; kind:ChannelProposal['kind']; at:string; month:string; state:ChannelState;
  peer:string; channel?:string; point?:string; amountSat:string; satPerVbyte:string; maxFeeSat:string;
  // Approved fee cap charged to the monthly on-chain budget until an outcome proves nothing was broadcast. Actual fee is not measured.
  feeChargedSat:string; txid?:string; closeType?:string; rejected?:boolean; reason?:string; ownerResolved?:boolean;
  history:{at:string;state:ChannelState;reason?:string}[];
}
const LIVE:ChannelState[]=['reserved','sending','uncertain','pending'];
const DISPATCHING:ChannelState[]=['reserved','sending','uncertain'];
const PEER=/^0[23][0-9a-f]{64}$/;

/** LND evidence horizon for an open: past it, no pending or open channel means the funding did not happen. */
export const OPEN_EVIDENCE_MS=2*3600_000;
// Failed operations whose effect LND could still complete later: owner close-outs and explicitly rejected closes. Watched for 14 days.
const lateWatch=(o:ChannelOperation,at:string)=>o.state==='failed'&&(o.ownerResolved===true||(o.kind==='channel_close'&&o.rejected===true))&&Date.parse(at)-Date.parse(o.at)<14*86400_000;
// Key range, not LIKE, so the meta primary key is used.
export const CHANNEL_OPERATION_KEYS="key>='channelOperation:' AND key<'channelOperation;'";
export function channelOperations(store:Store):ChannelOperation[] {
  return store.all(`SELECT value FROM meta WHERE ${CHANNEL_OPERATION_KEYS}`).map(r=>JSON.parse(r.value) as ChannelOperation).sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
}
/** Monthly (Europe/Rome) on-chain fee budget, separate from the v1 Lightning expense ledger. Pending opens and closes are on-chain obligations. */
export function channelBudget(store:Store,at=now()) {
  const ops=channelOperations(store),spent=ops.filter(o=>o.month===month(at)).reduce((n,o)=>n+integer(o.feeChargedSat),0n),cap=integer(CHANNEL_MANDATE.onchainMonthlyFeeSat);
  const obligations=ops.filter(o=>LIVE.includes(o.state)).reduce((n,o)=>n+integer(o.feeChargedSat)+(o.kind==='channel_open'?integer(o.amountSat):0n),0n);
  return {month:month(at),capSat:cap.toString(),spentSat:spent.toString(),remainingSat:(spent<cap?cap-spent:0n).toString(),pendingObligationsSat:obligations.toString()};
}
/** Approval binds identity, kind, peer and either the target channel or the funding wallet; routing balance changes do not invalidate a close. */
export function channelApprovalState(s:Snapshot,p:ChannelProposal) {
  const c=s.channels.find(c=>c.id===p.channel);
  return hash(json({identity:s.identity,synced:s.synced,kind:p.kind,peer:p.peer,...(p.kind==='channel_open'?{confirmedSat:s.confirmedSat,peerChannels:s.channels.filter(c=>c.peer===p.peer).map(c=>c.id)}:{channel:c?{id:c.id,point:c.point,peer:c.peer,capacitySat:c.capacitySat,active:c.active}:null})}));
}

/** Candidate graph for analysts; unavailable without the channel credential or when LND cannot answer. */
export async function candidateView(channels:ChannelLifecycle|undefined,peer:string) {
  if(!channels)return {available:false,reason:'Channel credential not provisioned; candidate graph unavailable'};
  try{return await channels.candidate(peer);}catch{return {available:false,reason:'LND node graph unavailable for this peer; unknown, not absent'};}
}
/** Owner-approved channel opens and cooperative closes. Nothing here dispatches without a consumed owner approval. */
export class ChannelLifecycle {
  /** Bound on waiting for a running reconcile before a dispatch gives up with nothing sent. */
  waitMs=30000;
  private busy=false;private released:Promise<void>=Promise.resolve();private release=()=>{};
  constructor(private store:Store,private node:NodeClient,private rpc:ChannelRpc){}
  private acquire(){this.busy=true;this.released=new Promise(r=>this.release=r);}
  private free(){this.busy=false;this.release();}
  /** Waits, bounded, for a running reconcile or dispatch; the caller rechecks busy synchronously afterwards. */
  private async idle(ms=this.waitMs){const end=Date.now()+ms;while(this.busy&&Date.now()<end){let timer:ReturnType<typeof setTimeout>|undefined;await Promise.race([this.released,new Promise(r=>timer=setTimeout(r,end-Date.now()))]);clearTimeout(timer);}}
  operations(){return channelOperations(this.store);}
  candidate(peer:string){return channelCandidate(this.store,this.rpc,peer);}
  budget(at=now()){return channelBudget(this.store,at);}
  /** Policy shared by proposal creation, owner approval and the intent transaction. */
  check(p:ChannelProposal,s:Snapshot,at=now()) {
    if(!channelKind(p.kind)||!CHANNEL_MANDATE.allowed.includes(p.kind))throw Error('Unsupported channel operation');
    if(typeof p.peer!=='string'||!PEER.test(p.peer)||p.peer===s.identity)throw Error('Channel: invalid peer');
    if(!p.problem||!p.evidence||!p.whyAct||!p.alternatives||!p.verify||!p.hypothesis)throw Error('Incomplete decision');
    if(!p.evidenceIds?.length||p.evidenceIds.some(e=>!this.store.one('SELECT id FROM evidence WHERE id=?',e)&&!this.store.one('SELECT id FROM events WHERE id=?',e)))throw Error('Unverified evidence references');
    if(this.store.get('expectedIdentity')&&s.identity!==this.store.get('expectedIdentity'))throw Error('Node identity mismatch');
    if(!s.synced)throw Error('Stale/unsynchronized state');
    const rate=integer(p.satPerVbyte??'0'),fee=integer(p.maxFeeSat??'0');
    if(rate<1n||rate>BigInt(CHANNEL_MANDATE.maxSatPerVbyte)||fee<1n)throw Error(`Channel: on-chain fee rate unavailable or above ${CHANNEL_MANDATE.maxSatPerVbyte} sat/vB`);
    const live=this.operations().filter(o=>LIVE.includes(o.state));
    if(live.some(o=>DISPATCHING.includes(o.state)))throw Error('Channel: another channel operation is in progress or uncertain; reconcile first');
    const b=this.budget(at);
    if(fee>integer(b.remainingSat))throw Error('Channel: monthly on-chain fee budget exhausted');
    if(p.kind==='channel_open') {
      const amount=integer(p.amountSat);
      if(amount<integer(CHANNEL_MANDATE.minOpenSat)||amount>integer(CHANNEL_MANDATE.maxOpenSat))throw Error('Channel: size outside 500,000–2,000,000 sat');
      if(s.channels.some(c=>c.peer===p.peer)||live.some(o=>o.peer===p.peer))throw Error('Channel: peer already has a channel or pending operation');
      // Funded only above the protected reserve plus every pending on-chain obligation, including pending opens.
      if(integer(s.confirmedSat)<integer(CHANNEL_MANDATE.reserveSat)+integer(this.store.get('pendingOnchainObligationsSat')??'0')+integer(b.pendingObligationsSat)+amount+fee)throw Error('Channel: protected on-chain reserve');
    } else {
      if(p.amountSat!=='0')throw Error('Channel: invalid close amount');
      const c=s.channels.find(c=>c.id===p.channel);
      if(!c||c.peer!==p.peer||(p.point!==undefined&&c.point!==p.point))throw Error('Channel: close target unavailable');
      if(live.some(o=>o.channel===c.id||o.point===c.point))throw Error('Channel: close already pending');
      if(!c.active)throw Error('Channel: peer offline; cooperative close not possible and force close is never used');
      if(c.pendingSat!=='0')throw Error('Channel: HTLCs pending; cooperative close deferred');
    }
  }
  /** Prices a draft from EstimateFee and binds the approved rate and fee cap. Never reserves or dispatches. */
  async price(draft:ChannelProposal,s:Snapshot,at=now()):Promise<ChannelProposal> {
    const reasons={evidenceIds:draft.evidenceIds,problem:draft.problem,evidence:draft.evidence,whyAct:draft.whyAct,alternatives:draft.alternatives,verify:draft.verify,hypothesis:draft.hypothesis};
    if(!channelKind(draft.kind))throw Error('Unsupported channel operation');
    let p:ChannelProposal;
    if(draft.kind==='channel_open') {
      const amount=integer(draft.amountSat).toString(),estimate=await this.rpc.estimateFee(amount,CHANNEL_MANDATE.targetConf);
      // Unknown candidate data stays unknown; it never blocks or zeroes the forecast.
      const candidate=await this.rpc.nodeInfo(draft.peer).catch(()=>undefined);
      const maxFeeSat=((integer(estimate.feeSat)*5n+3n)/4n).toString();
      p={kind:'channel_open',peer:draft.peer,...(draft.address?{address:draft.address}:{}),amountSat:amount,alias:candidate?.alias||undefined,satPerVbyte:estimate.satPerVbyte,maxFeeSat,...reasons,
        forecast:{estimatedFeeSat:estimate.feeSat,feeMarginPercent:25,candidate:candidate?{alias:candidate.alias,channels:candidate.channels,capacitySat:candidate.capacitySat,addresses:candidate.addresses.length}:'unknown'}};
      if(!p.address&&candidate?.addresses[0])p.address=candidate.addresses[0];
    } else {
      const c=s.channels.find(c=>c.id===draft.channel);
      if(!c)throw Error('Channel: close target unavailable');
      const estimate=await this.rpc.estimateFee('50000',CHANNEL_MANDATE.targetConf);
      p={kind:'channel_close',peer:c.peer,channel:c.id,point:c.point,amountSat:'0',alias:c.alias,satPerVbyte:estimate.satPerVbyte,maxFeeSat:(integer(estimate.satPerVbyte)*BigInt(CHANNEL_MANDATE.closeVbytes)).toString(),...reasons,
        forecast:{channel:{capacitySat:c.capacitySat,localSat:c.localSat,remoteSat:c.remoteSat,active:c.active},closeVbytes:CHANNEL_MANDATE.closeVbytes,feePayer:'channel opener; unknown here, reserved conservatively'}};
    }
    this.check(p,s,at);
    p.forecast={...p.forecast,monthlyBudget:this.budget(at),reserveSat:CHANNEL_MANDATE.reserveSat};
    return p;
  }
  /** Executes one consumed owner approval. A dispatch is written as intent first and is never repeated. */
  async execute(proposalId:string,approval:{validate:(s:Snapshot)=>void;reserved:(operation:string)=>void}) {
    await this.idle();if(this.busy)throw Error('Channel: executor busy with reconciliation; nothing was sent');this.acquire();
    try {
      const row=this.store.one('SELECT status,content,intent_at FROM owner_proposals WHERE id=?',proposalId);
      if(row?.status!=='executing'||!row.intent_at)throw Error('Owner approval required');
      const p=JSON.parse(row.content) as ChannelProposal;
      if(!channelKind(p.kind))throw Error('Unsupported channel operation');
      if(this.operations().some(o=>o.proposalId===proposalId))throw Error('Approval already used; no second execution');
      const s=await this.node.snapshot();
      approval.validate(s);
      if(p.kind==='channel_open'&&!(await this.rpc.listPeers()).includes(p.peer)){
        if(!p.address)throw Error('Channel: peer not connected and no address known');
        await this.rpc.connectPeer(p.peer,p.address);
      }
      // Fresh price right before dispatch: the UTXO set or the market may have moved since approval.
      const estimate=await this.rpc.estimateFee(p.kind==='channel_open'?p.amountSat:'50000',CHANNEL_MANDATE.targetConf).catch(()=>{throw Error('Channel: fee re-estimate unavailable; nothing was sent');});
      const approvedRate=integer(p.satPerVbyte!),freshRate=integer(estimate.satPerVbyte)>0n?integer(estimate.satPerVbyte):1n;
      const fresh=p.kind==='channel_open'?[integer(estimate.feeSat),(integer(estimate.feeSat)*approvedRate+freshRate-1n)/freshRate]:[freshRate*BigInt(CHANNEL_MANDATE.closeVbytes)];
      const worst=fresh.reduce((a,b)=>a>b?a:b);
      if(worst>integer(p.maxFeeSat!))throw Error(`Channel: fresh on-chain fee estimate ${worst} sat exceeds the approved ${p.maxFeeSat} sat; nothing was sent`);
      const op=this.store.tx(()=>{
        const at=now();
        if(!Number.isFinite(Date.parse(s.at))||Date.parse(s.at)>Date.parse(at)||Date.parse(at)-Date.parse(s.at)>60000)throw Error('Stale/unsynchronized state');
        this.check(p,s,at);
        const op:ChannelOperation={id:id(),proposalId,kind:p.kind,at,month:month(at),state:'reserved',peer:p.peer,...(p.channel?{channel:p.channel,point:p.point}:{}),amountSat:p.amountSat,satPerVbyte:p.satPerVbyte!,maxFeeSat:p.maxFeeSat!,feeChargedSat:p.maxFeeSat!,history:[{at,state:'reserved'}]};
        this.store.set('channelOperation:'+op.id,op);approval.reserved(op.id);return op;
      });
      try {
        // Recheck pause and host interlock immediately before the writable RPC. No await in between.
        this.store.assertDispatchReady();
        this.transition(op,'sending');
        if(p.kind==='channel_open'){const r=await this.rpc.openChannel(p.peer,op.amountSat,op.satPerVbyte);this.transition(op,'pending',{txid:r.txid,point:`${r.txid}:${r.outputIndex}`});}
        else {const r=await this.rpc.closeChannel(op.point!,op.satPerVbyte);this.transition(op,'pending',{txid:r.txid});}
        return {operation:op.id,state:op.state,txid:op.txid};
      } catch(error) {
        if(op.state==='reserved')this.transition(op,'failed',{feeChargedSat:'0',reason:'Blocked before dispatch; no RPC sent'});
        else if(op.state==='sending')this.transition(op,'uncertain',{rejected:(error as any)?.category==='rpc_failure',reason:'RPC rejected or interrupted; no replay, reconcile from pending/closed channels'});
        throw error;
      }
    } finally {this.free();}
  }
  /** Moves live operations from LND evidence only. Unknown stays uncertain; nothing is re-sent. */
  async reconcile(at=now()) {
    if(this.busy)return;
    // A close the owner marked failed may still complete if the peer later finishes a persisted shutdown; keep watching it for 14 days.
    const live=this.operations().filter(o=>LIVE.includes(o.state)||lateWatch(o,at));if(!live.length)return;
    this.acquire();try {
      // A reserved intent never reached its dispatch marker; no RPC could have occurred.
      for(const op of live.filter(o=>o.state==='reserved'))this.transition(op,'failed',{feeChargedSat:'0',reason:'Interrupted before dispatch; never replayed'},at);
      const rest=live.filter(o=>o.state!=='reserved');if(!rest.length)return;
      const s=await this.node.snapshot(),pending=await this.rpc.pendingChannels(),closed=await this.rpc.closedChannels();
      for(const op of rest) {
        if(op.kind==='channel_open') {
          // No other channel to this peer existed at intent, so peer and capacity identify the funding before its point is known.
          const ours=(c:{peer:string;point:string;capacitySat:string})=>op.point?c.point===op.point:c.peer===op.peer&&c.capacitySat===op.amountSat;
          const open=s.channels.find(ours),waiting=pending.opens.find(ours),cancelled=op.point?closed.find(c=>c.point===op.point&&['FUNDING_CANCELED','ABANDONED'].includes(c.type)):undefined;
          if(op.state==='failed'){if(open||waiting)this.transition(op,open?'confirmed':'pending',{point:(open??waiting)!.point,...(open?{channel:open.id}:{}),txid:(open??waiting)!.point.split(':')[0],feeChargedSat:op.maxFeeSat,reason:'Funding appeared after the owner marked it failed; recorded, never re-sent'},at);}
          else if(open)this.transition(op,'confirmed',{point:open.point,channel:open.id},at);
          else if(cancelled)this.transition(op,'failed',{closeType:cancelled.type,reason:'Funding cancelled or abandoned'},at);
          else if(waiting){if(op.state!=='pending')this.transition(op,'pending',{point:waiting.point,txid:waiting.point.split(':')[0]},at);}
          else if(op.state!=='pending'&&(op.rejected||Date.parse(at)-Date.parse(op.at)>OPEN_EVIDENCE_MS))this.transition(op,'failed',{feeChargedSat:'0',reason:'No pending or open channel observed; open did not happen'},at);
          else if(op.state==='sending')this.transition(op,'uncertain',{reason:'Dispatch interrupted; outcome unknown, never replayed'},at);
        } else {
          const done=closed.find(c=>c.point===op.point),waiting=pending.closing.find(c=>c.point===op.point),channel=s.channels.find(c=>c.point===op.point);
          const closeReason=(type:string)=>type==='COOPERATIVE_CLOSE'?undefined:`Closed on chain as ${type}; not our cooperative close`;
          if(op.state==='failed'){if(done||waiting)this.transition(op,done?'confirmed':'pending',{txid:done?.txid??waiting!.txid,closeType:done?.type,feeChargedSat:op.maxFeeSat,reason:(done&&closeReason(done.type))??'Close completed after it was recorded as failed; recorded, never re-sent'},at);}
          else if(done)this.transition(op,'confirmed',{txid:done.txid,closeType:done.type,reason:closeReason(done.type)},at);
          else if(waiting){if(op.state!=='pending'||op.txid!==waiting.txid)this.transition(op,'pending',{txid:waiting.txid},at);}
          // Only an explicit LND rejection with the link still active is a failure; a timeout stays uncertain. Never retried or forced.
          else if(op.state!=='pending'&&op.rejected===true&&channel?.active)this.transition(op,'failed',{feeChargedSat:'0',reason:'Cooperative close not in progress; peer offline or refused. No retry, no force close'},at);
          else if(op.state==='sending')this.transition(op,'uncertain',{reason:'Dispatch interrupted; outcome unknown, never replayed'},at);
        }
      }
    } finally {this.free();}
  }
  /** Owner close-out of an uncertain operation, allowed only when LND shows no trace of it. Never re-dispatches. */
  async ownerMarkFailed(operationId:string,at=now()) {
    await this.idle();if(this.busy)throw Error('Channel: executor busy; retry shortly');this.acquire();
    try {
      const uncertain=()=>{const op=this.store.get<ChannelOperation>('channelOperation:'+operationId);if(op?.state!=='uncertain')throw Error('Channel: operation is not uncertain');return op;};
      const early=uncertain();
      // LND may still be negotiating the funding after a client deadline; before the evidence horizon absence proves nothing.
      if(early.kind==='channel_open'&&Date.parse(at)-Date.parse(early.at)<OPEN_EVIDENCE_MS)throw Error(`Channel: too early; an open can be marked failed only 2 hours after dispatch (from ${new Date(Date.parse(early.at)+OPEN_EVIDENCE_MS).toISOString()})`);
      const op=uncertain(),s=await this.node.snapshot(),pending=await this.rpc.pendingChannels(),closed=await this.rpc.closedChannels();
      if(op.kind==='channel_open'){
        const ours=(c:{peer:string;point:string;capacitySat:string})=>op.point?c.point===op.point:c.peer===op.peer&&c.capacitySat===op.amountSat;
        if(s.channels.some(ours)||pending.opens.some(ours)||(op.point&&closed.some(c=>c.point===op.point)))throw Error('Channel: LND still shows this channel; it stays in reconciliation');
      } else if(pending.closing.some(c=>c.point===op.point)||closed.some(c=>c.point===op.point))throw Error('Channel: LND shows this close in progress or done; it stays in reconciliation');
      const current=uncertain();
      this.transition(current,'failed',{feeChargedSat:'0',ownerResolved:true,reason:'Owner marked failed after LND showed no pending or open channel; never re-sent'},at);
      return current;
    } finally {this.free();}
  }
  private transition(op:ChannelOperation,state:ChannelState,patch:Partial<ChannelOperation>={},at=now()) {
    Object.assign(op,patch,{state});op.history.push({at,state,...(patch.reason?{reason:patch.reason}:{})});
    this.store.set('channelOperation:'+op.id,op);
  }
}

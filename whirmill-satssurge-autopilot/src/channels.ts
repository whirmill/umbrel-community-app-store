import { protectedAutomationGuard } from './executor.js';
import type { Store } from './store.js';
import type { NodeClient, ChannelRpc } from './lnd.js';
import { id, now, json, hash, integer, month, channelKind, CHANNEL_MANDATE, type ChannelProposal, type Snapshot } from './domain.js';

export type ChannelState = 'reserved'|'sending'|'uncertain'|'pending'|'confirmed'|'failed';
export interface ChannelOperation {
  id:string; proposalId:string; kind:ChannelProposal['kind']; at:string; month:string; state:ChannelState;
  peer:string; channel?:string; point?:string; amountSat:string; satPerVbyte:string; maxFeeSat:string;
  // Approved fee cap charged to the monthly on-chain budget until an outcome proves nothing was broadcast. Actual fee is not measured.
  feeChargedSat:string; txid?:string; closeType?:string; rejected?:boolean; reason?:string;
  history:{at:string;state:ChannelState;reason?:string}[];
}
const LIVE:ChannelState[]=['reserved','sending','uncertain','pending'];
const DISPATCHING:ChannelState[]=['reserved','sending','uncertain'];
const PEER=/^0[23][0-9a-f]{64}$/;

export function channelOperations(store:Store):ChannelOperation[] {
  return store.all("SELECT value FROM meta WHERE key LIKE 'channelOperation:%'").map(r=>JSON.parse(r.value) as ChannelOperation).sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
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

/** Owner-approved channel opens and cooperative closes. Nothing here dispatches without a consumed owner approval. */
export class ChannelLifecycle {
  private busy=false;
  constructor(private store:Store,private node:NodeClient,private rpc:ChannelRpc){}
  operations(){return channelOperations(this.store);}
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
    if(this.busy)throw Error('Channel executor busy');this.busy=true;
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
      const op=this.store.tx(()=>{
        const at=now();
        if(!Number.isFinite(Date.parse(s.at))||Date.parse(s.at)>Date.parse(at)||Date.parse(at)-Date.parse(s.at)>60000)throw Error('Stale/unsynchronized state');
        this.check(p,s,at);
        const op:ChannelOperation={id:id(),proposalId,kind:p.kind,at,month:month(at),state:'reserved',peer:p.peer,...(p.channel?{channel:p.channel,point:p.point}:{}),amountSat:p.amountSat,satPerVbyte:p.satPerVbyte!,maxFeeSat:p.maxFeeSat!,feeChargedSat:p.maxFeeSat!,history:[{at,state:'reserved'}]};
        this.store.set('channelOperation:'+op.id,op);approval.reserved(op.id);return op;
      });
      try {
        // Recheck pause and host interlock immediately before the writable RPC. No await in between.
        protectedAutomationGuard(this.store);this.store.assertDispatchReady();
        this.transition(op,'sending');
        if(p.kind==='channel_open'){const r=await this.rpc.openChannel(p.peer,op.amountSat,op.satPerVbyte);this.transition(op,'pending',{txid:r.txid,point:`${r.txid}:${r.outputIndex}`});}
        else {const r=await this.rpc.closeChannel(op.point!,op.satPerVbyte);this.transition(op,'pending',{txid:r.txid});}
        return {operation:op.id,state:op.state,txid:op.txid};
      } catch(error) {
        if(op.state==='reserved')this.transition(op,'failed',{feeChargedSat:'0',reason:'Blocked before dispatch; no RPC sent'});
        else if(op.state==='sending')this.transition(op,'uncertain',{rejected:(error as any)?.category==='rpc_failure',reason:'RPC rejected or interrupted; no replay, reconcile from pending/closed channels'});
        throw error;
      }
    } finally {this.busy=false;}
  }
  /** Moves live operations from LND evidence only. Unknown stays uncertain; nothing is re-sent. */
  async reconcile(at=now()) {
    if(this.busy)return;
    const live=this.operations().filter(o=>LIVE.includes(o.state));if(!live.length)return;
    this.busy=true;try {
      // A reserved intent never reached its dispatch marker; no RPC could have occurred.
      for(const op of live.filter(o=>o.state==='reserved'))this.transition(op,'failed',{feeChargedSat:'0',reason:'Interrupted before dispatch; never replayed'},at);
      const rest=live.filter(o=>o.state!=='reserved');if(!rest.length)return;
      const s=await this.node.snapshot(),pending=await this.rpc.pendingChannels(),closed=await this.rpc.closedChannels();
      for(const op of rest) {
        if(op.kind==='channel_open') {
          // No other channel to this peer existed at intent, so peer and capacity identify the funding before its point is known.
          const ours=(c:{peer:string;point:string;capacitySat:string})=>op.point?c.point===op.point:c.peer===op.peer&&c.capacitySat===op.amountSat;
          const open=s.channels.find(ours),waiting=pending.opens.find(ours),cancelled=op.point?closed.find(c=>c.point===op.point&&['FUNDING_CANCELED','ABANDONED'].includes(c.type)):undefined;
          if(open)this.transition(op,'confirmed',{point:open.point,channel:open.id},at);
          else if(cancelled)this.transition(op,'failed',{closeType:cancelled.type,reason:'Funding cancelled or abandoned'},at);
          else if(waiting){if(op.state!=='pending')this.transition(op,'pending',{point:waiting.point,txid:waiting.point.split(':')[0]},at);}
          else if(op.state!=='pending'&&(op.rejected||Date.parse(at)-Date.parse(op.at)>2*3600_000))this.transition(op,'failed',{feeChargedSat:'0',reason:'No pending or open channel observed; open did not happen'},at);
          else if(op.state==='sending')this.transition(op,'uncertain',{reason:'Dispatch interrupted; outcome unknown, never replayed'},at);
        } else {
          const done=closed.find(c=>c.point===op.point),waiting=pending.closing.find(c=>c.point===op.point),channel=s.channels.find(c=>c.point===op.point);
          if(done)this.transition(op,'confirmed',{txid:done.txid,closeType:done.type},at);
          else if(waiting){if(op.state!=='pending'||op.txid!==waiting.txid)this.transition(op,'pending',{txid:waiting.txid},at);}
          // An active link proves no shutdown is in progress: the peer was offline or refused. Reported, never retried or forced.
          else if(op.state!=='pending'&&channel?.active)this.transition(op,'failed',{feeChargedSat:'0',reason:'Cooperative close not in progress; peer offline or refused. No retry, no force close'},at);
          else if(op.state==='sending')this.transition(op,'uncertain',{reason:'Dispatch interrupted; outcome unknown, never replayed'},at);
        }
      }
    } finally {this.busy=false;}
  }
  private transition(op:ChannelOperation,state:ChannelState,patch:Partial<ChannelOperation>={},at=now()) {
    Object.assign(op,patch,{state});op.history.push({at,state,...(patch.reason?{reason:patch.reason}:{})});
    this.store.set('channelOperation:'+op.id,op);
  }
}

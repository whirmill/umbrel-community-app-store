import { readFileSync,readdirSync,statSync } from 'node:fs';
import { basename,join } from 'node:path';
import { Store } from './store.js';
import { now,json,scrub,integer,hash } from './domain.js';

export function importHistory(store:Store,directory:string) {
  const files=readdirSync(directory).filter(f=>f.endsWith('.json')||f.endsWith('.md')).sort();
  const manifest:any[]=[];const problems:string[]=[];let entries=0;
  store.tx(()=>{
    for(const filename of files) {
      const path=join(directory,filename);if(!statSync(path).isFile() || statSync(path).size>8*1024*1024)continue;
      // Explicit receipts/docs only, never auth/config/raw session files.
      if(/(?:auth|credential|seed|macaroon|secret|payment-request)/i.test(filename))continue;
      const raw=readFileSync(path,'utf8');let obj:any;
      try{obj=filename.endsWith('.json')?JSON.parse(raw):undefined;}catch{problems.push(`${filename}: invalid JSON`);continue;}
      if(obj?.personal_payments)obj.personal_payments={note:'Personal payments excluded from agent evidence'};
      const content=obj?json(scrub(obj)):String(scrub(raw)).replace(/\b(?:lnbc|lntb)[a-z0-9]{50,}/g,'[INVOICE REDACTED]');
      const evidence=store.evidence('historical:'+basename(directory)+':'+filename,content,filename.endsWith('.md')?'historical-narrative':'receipt');
      store.run('INSERT OR IGNORE INTO claims VALUES(?,?,?,?,?,?)',evidence,now(),json({historical:true,source:filename,interpretation:'Original evidence retained; authorship/intent/authorization only as recorded, unknown fields remain unknown',currentAuthority:false}),evidence,'historical-uninterpreted',null);
      manifest.push({file:filename,originalDigest:hash(raw),selectedDigest:hash(content),evidence});
      if(filename==='experiment.json') {
        const old=store.get('historicalExperiment');if(old && old.experiment_start_utc!==obj.experiment_start_utc)throw new Error('Immutable experiment start conflict');
        store.set('historicalExperiment',scrub(obj));
      }
      if(filename==='expenses.json') {
        if(!Array.isArray(obj.entries))throw new Error('Invalid historical ledger');
        for(const e of obj.entries){
          const amount=e.amount_msat_exact!==undefined?integer(e.amount_msat_exact):integer(e.amount_sat)*1000n;
          store.ledger({id:String(e.id),at:e.timestamp_utc,classification:'expense',amountMsat:amount.toString(),category:e.kind==='rebalance'?'manual_rebalance':'historical',evidenceId:evidence,details:scrub(e)});entries++;
        }
        store.set('historicalCoverageComplete',obj.manual_coverage?.confirmed_complete===true);
        store.set('historicalLedgerImported',true);
      }
      if(filename==='reconciliation-20261005.json') {
        // Costs already belong to expenses.json. Do not double-book net swap and its fees.
        const gross=obj.swap?.gross_premium_msat??obj.swap?.gross_premium_msat_exact;
        if(gross!==undefined)store.ledger({id:'historical-robosats-gross-premium',at:obj.swap?.settled_at_utc??obj.verified_at_utc,classification:'revenue',amountMsat:integer(gross).toString(),evidenceId:evidence,details:{scope:'swap',note:'Gross premium; swap expenses separately in historical ledger'}});
        store.set('historicalReconciliationEvidence',evidence);
      }
    }
    store.set('importReport',{at:now(),files:manifest,ledgerEntriesRead:entries,problems,coverageComplete:store.get('historicalCoverageComplete')===true,note:'Historical documents are evidence, not authority. Old results remain dated snapshots. Full RPC state must be reconciled separately.'});
  });
  return store.get('importReport');
}

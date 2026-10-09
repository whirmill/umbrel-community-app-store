import { channelScid } from './diagnostics.js';
import { Store } from './store.js';
import { normalizeEvidenceQuery,type EvidenceQuery } from './evidence-views.js';
const adapters:Record<string,{table:string;time:string;source?:string;target?:string;channel?:string;join?:string}>={
 decisions:{table:'decisions d',time:'d.at',source:"json_extract(d.proposal,'$.source')",target:"json_extract(d.proposal,'$.target')"},
 operations:{table:'operations d',time:'d.at',join:' JOIN decisions parent ON parent.id=d.decision_id',source:"json_extract(parent.proposal,'$.source')",target:"json_extract(parent.proposal,'$.target')"},
 evaluations:{table:'evaluations d',time:'d.at',join:' JOIN decisions parent ON parent.id=d.decision_id',source:"json_extract(parent.proposal,'$.source')",target:"json_extract(parent.proposal,'$.target')"},
 evaluationWindows:{table:'evaluation_windows d',time:'d.at',join:' JOIN decisions parent ON parent.id=d.decision_id',source:"json_extract(parent.proposal,'$.source')",target:"json_extract(parent.proposal,'$.target')"},
 coverage:{table:'coverage d',time:'d.end'},claims:{table:'claims d',time:'d.at'},holds:{table:'channel_holds d',time:'d.at',channel:'d.channel_id'},
 manual_events:{table:'events d',time:'d.occurred_at',source:'d.source',target:'d.target'},policy_events:{table:'events d',time:'d.occurred_at',source:'d.source',target:'d.target'},
 corridor_events:{table:'events d',time:'d.occurred_at',source:'d.source',target:'d.target'},
};
export function evidenceSource(store:Store,input:EvidenceQuery){
 const q=normalizeEvidenceQuery(input);
 if(q.section==='channels')return {snapshot:store.get('snapshot')};
 if(q.section==='competition'||q.section==='competition_alternatives')return {competition:store.get('competition')};
 if(q.section==='diagnostics')return {diagnostics:store.get('diagnostics')};
 const a=adapters[q.section];if(!a)throw Error('Unsupported evidence adapter');
 const clauses:string[]=[],args:any[]=[];
 if(['manual_events','policy_events'].includes(q.section)){
   clauses.push("d.type=?");args.push(q.section==='manual_events'?'manual_operation':'manual_policy');
   const endpoints=[q.source,q.target,q.channel].filter(Boolean).map(decimal);
   if(endpoints.length){clauses.push(`(d.source IN (${endpoints.map(()=>'?')}) OR d.target IN (${endpoints.map(()=>'?')}) OR EXISTS (SELECT 1 FROM json_each(d.details,'$.affectedChannels') c WHERE c.value IN (${endpoints.map(()=>'?')})))`);args.push(...endpoints,...endpoints,...endpoints);}
 }
 for(const key of ['source' ,'target','channel'] as const)if(q[key]&&!['manual_events','policy_events'].includes(q.section)){
   const expr=a[key];
   if(key==='channel'&&!expr&&a.source&&a.target){clauses.push(`(${a.source}=? OR ${a.target}=?)`);args.push(decimal(q[key]),decimal(q[key]));}
   else {if(!expr)throw Error('Unsupported '+key+' filter for '+q.section);clauses.push(expr+'=?');args.push(decimal(q[key]));}
 }
 if(q.start){clauses.push('julianday('+a.time+')>=julianday(?)');args.push(q.start);}
 if(q.end){clauses.push('julianday('+(q.section==='coverage'?'d.start':a.time)+')<julianday(?)');args.push(q.end);}
 const rows=store.all(`SELECT d.* FROM ${a.table}${a.join??''}${clauses.length?' WHERE '+clauses.join(' AND '):''} ORDER BY ${a.time},${q.section==='holds'?'d.channel_id':'d.id'} LIMIT 10001`,...args);
 const coverage=store.all("SELECT start,end,kind,complete,details FROM coverage WHERE kind='LND forwards' ORDER BY start,end");
 return {[q.section]:rows.slice(0,10000),adapterFiltered:true,sourceMetadata:{schema:1,source:q.section==='corridor_events'?'LND original events':'operational receipts',coverage},projectionLimits:{selected:rows.length,processed:Math.min(rows.length,10000),limit:10000,truncated:rows.length>10000,upstreamHistoryComplete:false}};
}
function decimal(v:string|undefined){if(!v)return '';const [h,t,o]=channelScid(v).split('x').map(BigInt);return ((h!<<40n)+(t!<<16n)+o!).toString();}

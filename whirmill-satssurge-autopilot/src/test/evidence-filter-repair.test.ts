import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store.js';
import {EvidenceViews} from '../evidence-views.js';
import {evidenceSource} from '../evidence-source.js';
import {hash,json} from '../domain.js';
import {channelScid} from '../diagnostics.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('manual/policy directional AND filters exclude reverse rows and channel includes affected endpoints',()=>{
 const s=new Store(':memory:');try{for(const type of ['manual_operation','manual_policy'])for(const [id,source,target,affected] of [['forward','1','2',[]],['reverse','2','1',[]],['affected','3','4',['2']]])s.event({id:type+id,at:'2026-10-10T00:00:00Z',type,source:source as string,target:target as string,amountMsat:'0',feeMsat:'0',details:{affectedChannels:affected}});
 for(const section of ['manual_events','policy_events'] as const){const v=new EvidenceViews();const q={section,target:channelScid('2')};const page:any=v.page('job',evidenceSource(s,q),q);assert.equal(page.total,1);assert.equal(page.rows[0].source,'1');assert.equal(page.metadata.perRouteAllocationQualified,false);const combined:any=v.page('job',evidenceSource(s,{section,source:'1',target:'2'}),{section,source:'1',target:'2'});assert.equal(combined.total,1);const involved:any=v.page('other',evidenceSource(s,{section,channel:'2'}),{section,channel:'2'});assert.equal(involved.total,3);}
 }finally{s.close();}
});
test('missing receipt direction is unavailable rather than an invented empty scoped result',()=>{const s=new Store(':memory:');try{s.event({id:'unknown',at:'2026-10-10T00:00:00Z',type:'manual_operation',source:'',target:'',amountMsat:'0',feeMsat:'0'});s.event({id:'known',at:'2026-10-10T00:00:00Z',type:'manual_operation',source:'1',target:'2',amountMsat:'0',feeMsat:'0',details:{affectedChannels:['2','3']}});const q={section:'manual_events' as const,target:'2'};const page:any=new EvidenceViews().page('job',evidenceSource(s,q),q);assert.equal(page.available,false);assert.equal(page.unsupportedFilter,true);assert.equal(page.rows,null);}finally{s.close();}});
test('diagnostic channel uses normalized endpoints not observation ID, and missing channel stays unsupported',()=>{
 const state={diagnostics:{lightningMate:{rebalances:[{id:'99',source:'1',target:'2'},{id:'2',source:'3',target:'4'}],failures:[{target:'2'}]}}};
 const v=new EvidenceViews();const p:any=v.page('job',state,{section:'diagnostics',provider:'lightningMate',collection:'rebalances',channel:channelScid('2')});assert.equal(p.total,1);assert.equal(p.rows[0].id,'99');assert.equal(v.page('job',state,{section:'diagnostics',provider:'lightningMate',collection:'failures',channel:'2'}).available,true);
 const unknown:any=v.page('other',{diagnostics:{lightningMate:{rebalances:[{id:'2'}]}}},{section:'diagnostics',provider:'lightningMate',collection:'rebalances',channel:'2'});assert.equal(unknown.unsupportedFilter,true);
});
test('persisted immutable manual view survives reopen and preserves earlier cursor rows while fresh direction narrows',()=>{
 const dir=mkdtempSync(join(tmpdir(),'filter-cursor-')),path=join(dir,'state.sqlite');let s=new Store(path);try{for(let i=0;i<24;i++)s.event({id:'row'+i,at:'2026-10-10T00:00:00Z',type:'manual_operation',source:i%2?'1':'2',target:i%2?'2':'1',amountMsat:'0',feeMsat:'0'});
 const q={section:'manual_events' as const,channel:'2'};let v=new EvidenceViews(Date.now,300000,4e6,16e6,s);const first:any=v.page('job',evidenceSource(s,q),q);assert.equal(first.total,24);s.close();s=new Store(path);v=new EvidenceViews(Date.now,300000,4e6,16e6,s);const tail:any=v.page('job',{}, {...q,cursor:first.cursor,offset:first.nextOffset});assert.equal(tail.rows.length,4);assert.equal(tail.total,24);const narrowed:any=v.page('fresh',evidenceSource(s,{section:'manual_events',target:'2'}),{section:'manual_events',target:'2'});assert.equal(narrowed.total,12);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('legacy directional cursor retains immutable original rows and scope on reopen; fresh view qualifies v2 semantics',()=>{
 const dir=mkdtempSync(join(tmpdir(),'legacy-filter-')),path=join(dir,'state.sqlite');let s=new Store(path);try{const q={section:'manual_events' as const,target:'2'},legacyRows=Array.from({length:24},(_,i)=>({id:'legacy'+i,source:i%2?'1':'2',target:i%2?'2':'1',at:'2026-10-10T00:00:00Z'}));let v=new EvidenceViews(Date.now,300000,4e6,16e6,s);const first:any=v.page('original',{manual_events:legacyRows,adapterFiltered:true},q);const legacy=s.get<any>('evidenceView:'+first.cursor);delete legacy.metadata.filterSemanticsVersion;legacy.version=hash(json({schema:1,query:JSON.parse(legacy.query),rows:legacy.rows,coverage:legacy.metadata.coverage,limits:legacy.metadata.projectionLimits,captureComplete:legacy.metadata.captureComplete,captureCounts:legacy.metadata.captureCounts,upstreamHistoryComplete:legacy.metadata.upstreamHistoryComplete}));s.set('evidenceView:'+first.cursor,legacy);const saved=json(legacy);s.close();s=new Store(path);v=new EvidenceViews(Date.now,300000,4e6,16e6,s);const tail:any=v.page('original',{}, {...q,cursor:first.cursor,offset:20});assert.equal(tail.total,24);assert.equal(tail.rows.length,4);assert.equal(tail.metadata.filterSemantics,undefined);assert.equal(tail.filterSemantics,'legacy_unknown');assert.equal(json(s.get('evidenceView:'+first.cursor)),saved);assert.equal(tail.version,legacy.version);const same:any=v.page('same-rows',{manual_events:legacyRows,adapterFiltered:true},q);assert.equal(same.metadata.filterSemanticsVersion,2);assert.notEqual(same.version,legacy.version);
 for(let i=0;i<24;i++)s.event({id:'fresh'+i,at:'2026-10-10T00:00:00Z',type:'manual_operation',source:i%2?'1':'2',target:i%2?'2':'1',amountMsat:'0',feeMsat:'0'});const fresh:any=v.page('new',evidenceSource(s,q),q);assert.equal(fresh.total,12);assert.equal(fresh.metadata.filterSemantics,'directional-v2');
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

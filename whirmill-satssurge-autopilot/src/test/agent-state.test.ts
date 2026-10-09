import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stateSummary,statePage,STATE_PAGE_BYTES} from '../agent-state.js';
function fixture(){return {enabled:false,budget:{remainingMsat:'19294831'},pnl30:{netMsat:'-8391975'},partial:true,snapshot:{at:'2026-10-09T00:00:00Z',identity:'node',synced:true,confirmedSat:'502858',channels:Array.from({length:10},(_,i)=>({id:String(i),localSat:'250000'}))},diagnostics:{at:'now',lndg:{status:'qualified',coverage:{complete:false},failures:Array.from({length:201},(_,i)=>({id:String(i),distinctPaymentsUnknown:true,amountMsat:'900719925474099300'}))},lightningMate:{status:'unavailable'}},competition:{status:'qualified',coverage:'graph only',channels:Array.from({length:10},(_,i)=>({id:String(i),alias:'peer'+i,status:'partial',quotes:[{amountSat:'100000',ourFeeMsat:'40000'}],alternativesTruncated:true,alternatives:Array.from({length:100},(_,j)=>({id:String(j),ppm:'200'}))}))},decisions:[],operations:[],evaluations:[],evaluationWindows:[],coverage:[],claims:[],holds:[]};}
test('large live-shaped state retains accounting and coverage with bounded discoverable details',()=>{
  const s=fixture(),summary:any=stateSummary(s);
  assert.ok(Buffer.byteLength(JSON.stringify(s))>STATE_PAGE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(summary))<STATE_PAGE_BYTES);
  assert.equal(summary.pnl30.netMsat,'-8391975');assert.equal(summary.partial,true);
  assert.equal(summary.diagnostics.lndg.counts.failures,201);
  assert.equal(summary.diagnostics.lightningMate.counts.failures,null);
  assert.equal(summary.competition.channelCount,10);
  const p=statePage(s,{section:'competition'});
  assert.equal(p.rows.length,10);assert.equal(p.rows[9].quotes[0].ourFeeMsat,'40000');assert.equal(p.rows[9].availableAlternativeRows,100);
  assert.equal(p.rows[9].alternatives,undefined);
});
test('all diagnostic rows are recoverable exactly once without truncation and preserve exact integers',()=>{
  const s=fixture(),found:string[]=[];let offset=0,version:string|undefined;
  do{const p=statePage(s,{section:'diagnostics',provider:'lndg',collection:'failures',offset,version});
    assert.ok(Buffer.byteLength(JSON.stringify(p))<=STATE_PAGE_BYTES);
    assert.equal(p.metadata.coverage.complete,false);assert.equal(p.total,201);
    for(const r of p.rows){found.push(r.id);assert.equal(r.amountMsat,'900719925474099300');}
    version=p.version;offset=p.nextOffset;
  }while(offset!==null);
  assert.deepEqual(found,Array.from({length:201},(_,i)=>String(i)));
});
test('continuation rejects changed source instead of mixing acquisition versions or treating unknown as zero',()=>{
  const s=fixture();const a=statePage(s,{section:'diagnostics',provider:'lndg',collection:'failures'});
  assert.throws(()=>statePage(s,{section:'diagnostics',provider:'lndg',collection:'failures',offset:20}));
  s.diagnostics.lndg.failures[0]!.amountMsat='10';
  const b=statePage(s,{section:'diagnostics',provider:'lndg',collection:'failures',offset:20,version:a.version});
  assert.equal(b.changed,true);assert.equal(b.restartOffset,0);assert.deepEqual(b.rows,[]);
  const absent=statePage(s,{section:'diagnostics',provider:'lightningMate',collection:'failures'});assert.equal(absent.available,false);assert.equal(absent.total,null);
  const edges=statePage(s,{section:'competition_alternatives',channel:'9'});assert.equal(edges.metadata.alternativesTruncated,true);assert.equal(edges.total,100);
  assert.throws(()=>statePage(s,{section:'channels',offset:-1}));
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store.js';
import {canonicalDiagnostics,captureDigestOf} from '../canonical-consumers.js';

const archived=(s:Store)=>Number(s.one("SELECT count(*) n FROM canonical_original_archive WHERE original_table='meta' AND original_id='diagnostics'").n);
const capture=(at:string,rebalances:string[])=>({status:'qualified',version:'synthetic',capturedAt:at,coverage:{start:'2026-10-01T00:00:00.000Z',end:at,complete:false},rebalances:rebalances.map(id=>({id,at:'2026-10-02T00:00:00.000Z'}))});

test('timestamp-only diagnostic refreshes do not grow the immutable archive',()=>{
 const s=new Store(':memory:');try{
  s.set('diagnostics',{at:'2026-10-25T07:00:00.000Z',lightningMate:capture('2026-10-25T07:00:00.000Z',['a'])});
  const first=archived(s);
  for(let minute=1;minute<=20;minute++){const at=`2026-10-25T07:${String(minute).padStart(2,'0')}:00.000Z`;s.set('diagnostics',{at,lightningMate:capture(at,['a'])});}
  assert.equal(archived(s),first);
  s.set('diagnostics',{at:'2026-10-25T08:00:00.000Z',lightningMate:capture('2026-10-25T08:00:00.000Z',['a','b'])});
  assert.equal(archived(s),first+2);
  assert.equal(s.get<any>('diagnostics').lightningMate.capturedAt,'2026-10-25T08:00:00.000Z');
 }finally{s.close();}
});

test('a capture digest survives refreshes that only move timestamps',()=>{
 const s=new Store(':memory:');try{
  const before=capture('2026-10-25T07:00:00.000Z',['a','b']);
  s.set('diagnostics',{at:'2026-10-25T07:00:00.000Z',lightningMate:before});
  s.set('diagnostics',{at:'2026-10-25T07:00:30.000Z',lightningMate:capture('2026-10-25T07:00:30.000Z',['a','b'])});
  const page:any=canonicalDiagnostics(s,{provider:'lightningMate',collection:'rebalances',diagnosticCaptureDigest:captureDigestOf(before)});
  assert.deepEqual(page.diagnostics.lightningMate.rebalances.map((r:any)=>r.id),['a','b']);
  assert.notEqual(captureDigestOf(before),captureDigestOf(capture('2026-10-25T07:00:30.000Z',['a'])));
 }finally{s.close();}
});

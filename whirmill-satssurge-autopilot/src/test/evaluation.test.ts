import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store.js';
import {evaluate,evaluateWindows,reviseEvaluation} from '../economics.js';
import {json} from '../domain.js';
const start='2026-10-01T00:00:00.000Z',day7='2026-10-08T00:00:00.000Z',day30='2026-10-31T00:00:00.000Z';
function fixture(kind='rebalance'){
  const s=new Store(':memory:');
  const p={kind,source:kind==='fee_change'?'':'a',target:'b',amountSat:'1000',demandKey:'a->b',evidenceIds:[]};
  const forecast={version:2,eligible:true,benefitMsat:'1000',baseline:{at:start,sourceInboundMsat:'10000',targetOutboundMsat:'10000',targetPpm:100,targetBaseMsat:'0',rate7MsatPerHour:'100',rate30MsatPerHour:'100',conservativeDemand30Msat:'36000',opportunityCostMsat:'0'}};
  s.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)','d',start,json(p),json(forecast),'{}','observing');
  s.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)','op','d',start,'SUCCEEDED',null,null,'{}');
  s.ledger({id:'expense',at:start,classification:'expense',amountMsat:'500',operationId:'op'});
  for(let i=0;i<10;i++)s.event({id:'event:'+i,at:'2026-10-02T00:00:'+String(i).padStart(2,'0')+'.000Z',type:'external_forward',source:i%2?'a':'c',target:'b',amountMsat:'10000',feeMsat:'100'});
  return {s,forecast};
}
function complete(s:Store){s.run('INSERT INTO coverage VALUES(?,?,?,?,?,?)','full','2026-09-01T00:00:00.000Z',day30,'LND forwards',1,'{}');}
test('7/30 evaluations mature separately and preserve the exact original forecast',()=>{
  const {s,forecast}=fixture('fee_change');complete(s);
  evaluateWindows(s,'2026-10-07T23:59:59.000Z');assert.equal(s.all('SELECT * FROM evaluation_windows').length,0);
  evaluateWindows(s,day7);assert.equal(s.all('SELECT * FROM evaluation_windows').length,1);
  const first=s.one('SELECT * FROM evaluation_windows');let result=JSON.parse(first.result);assert.deepEqual(result.originalForecast,forecast);assert.equal(result.samples,10);assert.equal(result.priceComparison.comparable,false);assert.equal(result.causalProfitCertified,false);
  evaluateWindows(s,day30);evaluateWindows(s,day30);assert.equal(s.all('SELECT * FROM evaluation_windows').length,2);
  assert.equal(s.one('SELECT result FROM evaluation_windows WHERE horizon_days=7').result,first.result);s.close();
});
test('missing coverage stays inconclusive with unknown observed amounts and later corrections append',()=>{
  const {s}=fixture('fee_change');evaluateWindows(s,day7);
  const old=s.one('SELECT * FROM evaluation_windows');const original=JSON.parse(old.result);assert.equal(original.status,'inconclusive');assert.equal(original.observedCorridorFeesMsat,null);
  complete(s);evaluateWindows(s,day7);assert.equal(s.one('SELECT result FROM evaluation_windows').result,old.result);
  assert.throws(()=>reviseEvaluation(s,'d',7,'',day7),/reason/);
  const key=reviseEvaluation(s,'d',7,'Forward coverage was reconciled after the initial report',day7);
  const fresh=JSON.parse(s.one('SELECT result FROM evaluation_windows WHERE id=?',key).result);assert.equal(fresh.correction.supersedes,old.id);assert.equal(fresh.observedCorridorFeesMsat,'1000');assert.equal(s.one('SELECT result FROM evaluation_windows WHERE revision=1').result,old.result);s.close();
});
test('manual interventions contaminate comparisons and failed operations never earn evaluations',()=>{
  const {s}=fixture('fee_change');complete(s);s.event({id:'manual',at:'2026-10-03T00:00:00.000Z',type:'manual_policy',source:'b',target:'b',amountMsat:'0',feeMsat:'0'});
  evaluateWindows(s,day30);const result=JSON.parse(s.one('SELECT result FROM evaluation_windows').result);assert.equal(result.status,'confounded');assert.deepEqual(result.manualEventIds,['manual']);assert.equal(result.modelComparison,null);
  s.run("UPDATE operations SET state='FAILED'");s.run('DELETE FROM evaluation_windows');evaluateWindows(s,day30);assert.equal(s.all('SELECT * FROM evaluation_windows').length,0);s.close();
});
test('fee changes are observed for seven days instead of judging an empty source corridor after 48h',()=>{
  const {s}=fixture('fee_change');complete(s);evaluate(s,'2026-10-03T00:00:00.000Z');assert.equal(s.one('SELECT status FROM decisions').status,'observing');
  evaluate(s,day7);const result=JSON.parse(s.one('SELECT result FROM evaluations').result);assert.equal(result.samples,10);assert.equal(result.coverageComplete,true);assert.equal(s.one('SELECT status FROM evaluations').status,'inconclusive');assert.equal(s.one('SELECT status FROM strategies').status,'suspended');s.close();
});

test('fee comparisons qualify only after two days of measured active liquid same-price samples',()=>{
  const {s}=fixture('fee_change');complete(s);
  const proposal=JSON.parse(s.one('SELECT proposal FROM decisions').proposal);proposal.newPpm=360;s.run('UPDATE decisions SET proposal=?',json(proposal));
  const prediction=JSON.parse(s.one('SELECT forecast FROM decisions').forecast);prediction.baseline.targetPpm=300;s.run('UPDATE decisions SET forecast=?',json(prediction));
  const snapshot=(at:string,ppm:number)=>({at,identity:'self',synced:true,confirmedSat:'500000',channels:[{id:'b',active:true,localSat:'10000',remoteSat:'10000',reserveSat:'1000',pendingSat:'0',ppm,baseMsat:'0'}]});
  s.tx(()=>{
    for(const side of [-1,1])for(let n=0;n<=1440;n++){
      const at=new Date(Date.parse(start)+(side===-1?-48*3600000:0)+n*120000).toISOString();
      s.saveSnapshot(snapshot(at,side===-1?300:360) as any);
    }
    for(let n=0;n<10;n++)s.event({id:'before:'+n,at:new Date(Date.parse(start)-48*3600000+n*60000).toISOString(),type:'external_forward',source:'a',target:'b',amountMsat:'10000',feeMsat:'50'});
  });
  evaluate(s,'2026-10-02T23:59:00.000Z');assert.equal(s.one('SELECT status FROM decisions').status,'observing');
  evaluate(s,'2026-10-03T00:00:00.000Z');const result=JSON.parse(s.one('SELECT result FROM evaluations').result);
  assert.equal(result.priceComparison.comparable,true);assert.equal(result.priceComparison.before.hours,48);assert.equal(result.priceComparison.after.hours,48);assert.equal(s.one('SELECT status FROM evaluations').status,'observed-positive');assert.equal(result.causalProfitCertified,false);s.close();
});

test('prior shared-channel strategies and unreconciled holds contaminate later windows',()=>{
  const {s}=fixture('fee_change');complete(s);
  s.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)','prior','2026-09-30T00:00:00.000Z',json({source:'c',target:'b'}),'{}','{}','evaluated');
  s.run('INSERT INTO channel_holds VALUES(?,?,?,?)','b','2026-10-02T00:00:00.000Z','External policy under reconciliation',start);
  evaluateWindows(s,day7);const report=JSON.parse(s.one('SELECT result FROM evaluation_windows').result);assert.equal(report.status,'confounded');assert.deepEqual(report.overlappingDecisionIds,['prior']);assert.equal(report.channelHolds[0].channel_id,'b');s.close();
});

test('post-intervention windows begin at reconciled settlement, not decision creation',()=>{
  const {s}=fixture('fee_change');complete(s);s.run("UPDATE ledger SET at='2026-10-03T00:00:00.000Z' WHERE id='expense'");
  evaluateWindows(s,day7);assert.equal(s.all('SELECT * FROM evaluation_windows').length,0);
  evaluateWindows(s,'2026-10-10T00:00:00.000Z');const result=JSON.parse(s.one('SELECT result FROM evaluation_windows').result);assert.equal(result.start,'2026-10-03T00:00:00.000Z');assert.equal(result.decisionCreatedAt,start);assert.equal(result.samples,0);s.close();
});

test('preceding intervention overlap follows delayed completion rather than old creation date',()=>{
  const {s}=fixture();complete(s);s.run("UPDATE decisions SET at='2026-10-02T00:00:00.000Z' WHERE id='d'");s.run("UPDATE ledger SET at='2026-10-02T00:00:00.000Z' WHERE id='expense'");s.run("UPDATE events SET source='a'");
  const historicalProposal=JSON.parse(s.one("SELECT proposal FROM decisions WHERE id='d'").proposal);
  s.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)','delayed','2026-09-01T00:00:00.000Z',json({...historicalProposal,source:'a',target:'b'}),'{}','{}','evaluated');
  s.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)','old-op','delayed','2026-09-01T00:00:00.000Z','SUCCEEDED',null,null,json({completedAt:'2026-09-03T00:00:00.000Z'}));
  evaluateWindows(s,'2026-10-09T00:00:00.000Z');const report=JSON.parse(s.one('SELECT result FROM evaluation_windows').result);assert.equal(report.status,'confounded');assert.deepEqual(report.overlappingDecisionIds,['delayed']);s.close();
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {announcedFee,qualifyCompetition} from '../competition.js';
import type {Snapshot} from '../domain.js';

const own='02'+'1'.repeat(64),peer='03'+'2'.repeat(64),neighbor='02'+'3'.repeat(64);
const at='2026-10-09T04:00:00.000Z';
const snapshot:Snapshot={at,identity:own,synced:true,confirmedSat:'500000',channels:[{id:'1066880321721991171',point:'point:0',peer,alias:'peer',active:true,capacitySat:'500000',localSat:'250000',remoteSat:'250000',reserveSat:'10000',pendingSat:'0',baseMsat:'1000',ppm:300,cltv:80,minMsat:'1000',maxMsat:'500000000'}]};
const edge=(id:string,ppm:string,disabled=false)=>({channelId:id,neighbor,capacitySat:'1000000',baseMsat:'0',ppm,minMsat:'1000',maxMsat:'1000000000',disabled,lastUpdate:'1791518400'});
function source(){return {schema:1,identity:own,version:'0.21.3-beta',capturedAt:at,peers:[{status:'ok',peer,captureComplete:true,liquidityKnown:false,trafficKnown:false,declaredChannels:'4',capturedChannels:4,missingPolicies:1,policies:[edge('1','100'),edge('2','300'),edge('3','900',true)]}]};}

test('competition quotes use exact base plus proportional fee and never infer liquidity or traffic',()=>{
  assert.equal(announcedFee('1000','300','100000000'),'31000');
  assert.equal(announcedFee('0','1','1'),'1');
  assert.equal(announcedFee('0','1','900719925474099300'),'900719925475');
  const result:any=qualifyCompetition(source(),snapshot,at);assert.equal(result.status,'qualified');
  const q=result.channels[0].quotes[1];assert.equal(q.announcedEligible,2);assert.equal(q.ourFeeMsat,'31000');
  assert.equal(q.cheaperThanUs,2);assert.equal(q.executionLiquidityUnknown,true);assert.equal(result.channels[0].disabledPolicies,1);
});
test('bounds, missing policies and incomplete graph stay explicit instead of inventing prices',()=>{
  const raw=source();raw.peers[0]!.captureComplete=false;
  const result:any=qualifyCompetition(raw,snapshot,at);assert.equal(result.channels[0].status,'partial');
  raw.peers[0]!.policies=[];
  const empty:any=qualifyCompetition(raw,snapshot,at);assert.equal(empty.channels[0].quotes[0].medianFeeMsat,null);
  assert.equal(empty.channels[0].missingPolicies,1);
  assert.equal(qualifyCompetition(raw,snapshot,'2026-10-09T04:06:00Z').status,'unavailable');
  raw.peers[0]!.policies=[edge('1','100'),edge('1','300')];assert.equal(qualifyCompetition(raw,snapshot,at).status,'unavailable');
});

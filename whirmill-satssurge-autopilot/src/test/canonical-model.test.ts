import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {CanonicalModel,digest,type Observation,type Coverage} from '../canonical-model.js';
import {migrateCanonical} from './native-canonical-fixture.js';
const at='2026-10-10T08:00:00.000Z',end='2026-10-10T09:00:00.000Z';
function fixture(){const db=new DatabaseSync(':memory:');db.exec('PRAGMA user_version=6');migrateCanonical(db);return {db,m:new CanonicalModel(db)};}
const observation=(extra:Partial<Observation>={}):Observation=>({nodeId:'node-A',network:'mainnet',kind:'payment',meaning:'lnd_effect',source:'LND',sourceVersion:'0.21.3-beta',sourceInstance:'node-A:LND',originalId:'payment-1',batchId:'batch-1',occurredAt:at,observedAt:at,timestampNs:'1791619200000000123',granularity:'settled effect',amountMsat:'900719925474099312345',feeMsat:'1001',sourceChannel:'1x2x3',targetChannel:'1099511758851',payload:{status:'SUCCEEDED'},...extra});
const coverage=(extra:Partial<Coverage>={}):Coverage=>({nodeId:'node-A',network:'mainnet',capability:'forwards',scope:'node',source:'LND',epoch:'e1',start:at,end,observedAt:end,status:'complete',details:{pagesComplete:true},...extra});
test('exact units, canonical channel IDs, timestamps and source/checksum survive immutable observations',()=>{const {db,m}=fixture();const o=observation({originalDigest:digest('original'),signedFeeDeltaMsat:'-42'}),id=m.observe(o);assert.equal(m.observe(o),id);const row=m.observation(id);assert.equal(row.amount_msat,o.amountMsat);assert.equal(row.timestamp_ns,o.timestampNs);assert.equal(row.target_channel,'1x2x3');assert.equal(row.signed_fee_delta_msat,'-42');assert.equal(row.source_version,'0.21.3-beta');assert.equal(row.original_digest,digest('original'));assert.throws(()=>m.observe({...o,id,feeMsat:'1002'}),/Immutable/);assert.throws(()=>db.prepare('UPDATE canonical_observations SET payload=? WHERE id=?').run('{}',id),/Immutable/);assert.throws(()=>db.prepare('DELETE FROM canonical_observations WHERE id=?').run(id),/Immutable/);db.close();});
test('cross-source payment candidates retain ambiguous correspondence without booking or collapsing observations',()=>{const {db,m}=fixture();const a=m.observe(observation()),b=m.observe(observation({source:'historical adapter',sourceInstance:'archive',originalId:'external-99'}));const key='9007199254740993',x=m.identify(a,{namespace:'payment_index',key}),y=m.identify(b,{namespace:'payment_index',key});assert.equal(x.entityId,y.entityId);assert.equal(m.effects({nodeId:'node-A',network:'mainnet',kind:'payment'}).entities![0].observationIds.length,2);assert.equal(db.prepare('SELECT count(*) n FROM canonical_observations').get()?.n,2);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='ledger'").get()?.n,0);db.close();});
test('conflicting exact costs and ambiguous links remain explicit and unqualified',()=>{const {db,m}=fixture(),key='2';const a=m.observe(observation()),b=m.observe(observation({originalId:'different',feeMsat:'1002'}));const entity=m.identify(a,{namespace:'payment_index',key}).entityId;assert.equal(m.identify(b,{namespace:'payment_index',key}).status,'conflict');assert.equal(m.effects({nodeId:'node-A',network:'mainnet',kind:'payment'}).entities![0].status,'unresolved');m.link({observationId:a,entityId:entity,relation:'ambiguous',method:'candidate-only',details:{reason:'two originals'}});assert.equal(db.prepare("SELECT count(*) n FROM canonical_evidence_links WHERE relation='conflict'").get()?.n,1);db.close();});
test('identical tuples preserve forward multiplicity, attempts and node/network isolation',()=>{const {db,m}=fixture();const a=m.observe(observation({kind:'forward',originalId:'cursor-1'})),b=m.observe(observation({kind:'forward',originalId:'cursor-2'}));assert.notEqual(a,b);assert.equal(m.query({nodeId:'node-A',network:'mainnet',kind:'forward'}).rows.length,2);const x=m.identify(a,{namespace:'htlc_circuit',key:'e1:1:1:2:2:forward:123'}),y=m.identify(b,{namespace:'htlc_circuit',key:'e1:1:3:2:4:forward:123'});assert.notEqual(x.entityId,y.entityId);const c=m.observe(observation({network:'testnet',originalId:'cursor-1',kind:'forward'}));assert.notEqual(m.identify(c,{namespace:'htlc_circuit',key:'e1:1:1:2:2:forward:123'}).entityId,x.entityId);db.close();});
test('unknown bindings and external intent cannot masquerade as native effects',()=>{const {db,m}=fixture();const unknown=m.observe(observation({nodeId:null,network:null}));assert.throws(()=>m.identify(unknown,{namespace:'payment_hash',key:'a'.repeat(64)}),/binding/);const intent=m.observe(observation({meaning:'external_intent'}));assert.throws(()=>m.identify(intent,{namespace:'payment_hash',key:'a'.repeat(64)}),/kind\/meaning\/namespace/);assert.throws(()=>m.observe(observation({amountMsat:9007199254740993 as any})),/decimal/);assert.throws(()=>m.observe(observation({payload:{preimage:'excluded'}})),/Sensitive/);db.close();});
test('coverage union requires explicit complete intervals; gaps, unknown and freshness fail closed',()=>{const {db,m}=fixture();const r={nodeId:'node-A',network:'mainnet',capability:'forwards',scope:'node',start:at,end};assert.equal(m.coverageRequirement(r).qualified,false);const mid='2026-10-10T08:30:00.000Z';m.appendCoverage(coverage({end:mid}));m.appendCoverage(coverage({start:mid}));assert.equal(m.coverageRequirement(r).qualified,true);m.appendCoverage(coverage({start:mid,status:'gap',details:{reason:'non-replayable reconnect'}}));assert.equal(m.coverageRequirement(r).qualified,false);assert.equal(m.coverageRequirement({...r,nodeId:null}).qualified,false);assert.throws(()=>m.appendCoverage(coverage({supersedes:'missing'})),/scope/);db.close();const f=fixture();f.m.appendCoverage(coverage());assert.deepEqual(f.m.coverageRequirement({...r,at:'2026-10-10T10:00:00Z',maxAgeMs:60000}).reasons,['stale_coverage']);f.db.close();});
test('projection evidence/digest and revisions are immutable, versioned and reproducible',()=>{const {db,m}=fixture(),id=m.observe(observation()),cid=m.appendCoverage(coverage());const input={name:'fees',scope:'node-A/mainnet',epoch:'epoch-1',calculationVersion:'fees-v1',observationIds:[id],coverageIds:[cid],result:{feeMsat:'1001',coverageComplete:true}};const first=m.publishProjection(input);assert.equal(m.publishProjection(input),first);const next=m.publishProjection({...input,calculationVersion:'fees-v2',supersedes:first,result:{feeMsat:'1001',coverageComplete:false}});assert.notEqual(first,next);assert.equal(db.prepare('SELECT count(*) n FROM canonical_projection_revisions').get()?.n,2);assert.throws(()=>db.prepare('DELETE FROM canonical_projection_revisions WHERE id=?').run(first),/Immutable/);assert.throws(()=>m.publishProjection({...input,observationIds:['missing']}),/Missing/);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);db.close();});
test('bounded deterministic queries retain unknown completeness and explicit truncation',()=>{const {db,m}=fixture();for(let i=0;i<3;i++)m.observe(observation({originalId:String(i)}));const page=m.query({nodeId:'node-A',network:'mainnet',start:at,end,limit:2});assert.equal(page.rows.length,2);assert.equal(page.truncated,true);assert.equal(page.complete,false);assert.throws(()=>m.query({nodeId:'node-A',network:'mainnet',limit:0}),/Bounded/);db.close();});

test('attempt IDs include payment identity and HTLC identities include epoch/circuit/variant/ns',()=>{const {db,m}=fixture();const a=m.observe(observation({kind:'payment_attempt'})),b=m.observe(observation({kind:'payment_attempt',originalId:'attempt-b'}));assert.throws(()=>m.identify(a,{namespace:'payment_attempt',key:'1'}),/payment_index/);const x=m.identify(a,{namespace:'payment_attempt',key:'1:1'}),y=m.identify(b,{namespace:'payment_attempt',key:'2:1'});assert.notEqual(x.entityId,y.entityId);const c=m.observe(observation({kind:'forward',originalId:'forward-c'}));assert.throws(()=>m.identify(c,{namespace:'htlc_circuit',key:'1:2'}),/client scope/);assert.notEqual(m.identify(c,{namespace:'htlc_circuit',key:'epoch-1:1:2:3:4:forward:123'}).entityId,m.identify(c,{namespace:'htlc_circuit',key:'epoch-2:1:2:3:4:forward:123'}).entityId);db.close();});
test('projection lineage changes create a new revision without altering the first digest',()=>{const {db,m}=fixture();const id=m.observe(observation());const input={name:'revision',scope:'node',epoch:'epoch',calculationVersion:'v1',observationIds:[id],coverageIds:[],result:{available:false}};const first=m.publishProjection(input),before=db.prepare('SELECT * FROM canonical_projection_revisions WHERE id=?').get(first);m.link({observationId:id,referenceTable:'original-records',referenceId:'receipt-1',relation:'original',method:'qualified-original-v1',details:{}});const second=m.publishProjection({...input,supersedes:first});assert.notEqual(first,second);assert.deepEqual(db.prepare('SELECT * FROM canonical_projection_revisions WHERE id=?').get(first),before);assert.equal(JSON.parse((db.prepare('SELECT lineage_ids FROM canonical_projection_revisions WHERE id=?').get(second) as any).lineage_ids).length,1);db.close();});

test('subscription readiness is distinct from history coverage and fails on disconnect or unknown epoch',()=>{const {db,m}=fixture();const r={nodeId:'node-A',network:'mainnet',capability:'htlc',scope:'node',epoch:'stream-1',at:end,maxAgeMs:60000};assert.equal(m.readinessRequirement(r).qualified,false);m.appendCoverage(coverage({capability:'htlc',epoch:'stream-1',start:end,end,status:'ready'}));assert.equal(m.readinessRequirement(r).qualified,true);assert.equal(m.coverageRequirement({...r,start:at,end}).qualified,false);m.appendCoverage(coverage({capability:'htlc',epoch:'stream-1',start:end,end,status:'gap',details:{reason:'disconnect'}}));assert.equal(m.readinessRequirement(r).qualified,false);assert.equal(m.readinessRequirement({...r,epoch:'stream-2'}).qualified,false);db.close();});

test('identical calculation/input identity cannot silently publish contradictory output',()=>{const {db,m}=fixture();const id=m.observe(observation());const input={name:'deterministic',scope:'node',epoch:'epoch',calculationVersion:'v1',observationIds:[id],coverageIds:[],result:{feeMsat:'1001'}};const first=m.publishProjection(input);assert.throws(()=>m.publishProjection({...input,result:{feeMsat:'999'}}),/Immutable/);assert.equal(db.prepare('SELECT count(*) n FROM canonical_projection_revisions').get()?.n,1);assert.equal(m.publishProjection(input),first);db.close();});

test('effect queries expose unknown bindings and unqualified original observations',()=>{const {db,m}=fixture();const id=m.observe(observation());assert.equal(m.effects({nodeId:null,network:null,kind:'payment'}).available,false);const rows=m.effects({nodeId:'node-A',network:'mainnet',kind:'payment'});assert.deepEqual(rows.entities,[]);assert.deepEqual(rows.unresolvedObservationIds,[id]);assert.equal(rows.complete,false);db.close();});


test('known single-effect endpoints conflict while aggregate payment routes remain distinct evidence',()=>{
 const {db,m}=fixture(),key='3';
 const a=m.observe(observation({sourceChannel:'0x0x2',targetChannel:'0x0x4'}));
 const b=m.observe(observation({originalId:'contrary-source',sourceChannel:'0x0x3',targetChannel:'0x0x4'}));
 const c=m.observe(observation({originalId:'contrary-target',sourceChannel:'0x0x2',targetChannel:'0x0x5'}));
 m.identify(a,{namespace:'payment_index',key});
 assert.equal(m.identify(b,{namespace:'payment_index',key}).status,'conflict');
 assert.equal(m.identify(c,{namespace:'payment_index',key}).status,'conflict');
 assert.equal(m.effects({nodeId:'node-A',network:'mainnet',kind:'payment'}).entities![0].status,'unresolved');
 const aggregate=m.observe(observation({originalId:'aggregate-a',endpointScope:'aggregate',sourceChannel:'0x0x2'}));
 const routed=m.observe(observation({originalId:'aggregate-b',endpointScope:'aggregate',sourceChannel:'0x0x3'}));
 const aggregateKey='4';m.identify(aggregate,{namespace:'payment_index',key:aggregateKey});
 assert.equal(m.identify(routed,{namespace:'payment_index',key:aggregateKey}).status,'ambiguous');
 // A concrete attempt still compares endpoints even when incorrectly labelled aggregate.
 const attemptKey=aggregateKey+':1',aa=m.observe(observation({kind:'payment_attempt',originalId:'attempt-a',endpointScope:'aggregate',sourceChannel:'0x0x2'})),ab=m.observe(observation({kind:'payment_attempt',originalId:'attempt-b',endpointScope:'aggregate',sourceChannel:'0x0x3'}));m.identify(aa,{namespace:'payment_attempt',key:attemptKey});
 assert.equal(m.identify(ab,{namespace:'payment_attempt',key:attemptKey}).status,'conflict');db.close();
});
test('historical coverage supersession cannot erase disjoint or partly uncovered gaps',()=>{
 const {db,m}=fixture(),r={nodeId:'node-A',network:'mainnet',capability:'forwards',scope:'node',start:at,end};
 m.appendCoverage(coverage());
 const gap=m.appendCoverage(coverage({start:'2026-10-10T08:10:00Z',end:'2026-10-10T08:20:00Z',status:'gap',details:{reason:'disconnect'}}));
 assert.throws(()=>m.appendCoverage(coverage({start:'2026-10-10T10:00:00Z',end:'2026-10-10T11:00:00Z',supersedes:gap})),/preserve historical interval/);
 assert.throws(()=>m.appendCoverage(coverage({start:'2026-10-10T08:15:00Z',supersedes:gap})),/preserve historical interval/);
 assert.throws(()=>m.appendCoverage(coverage({status:'ready',supersedes:gap})),/preserve historical interval/);
 assert.equal(m.coverageRequirement(r).qualified,false);
 assert.equal(db.prepare('SELECT count(*) n FROM canonical_coverage').get()?.n,2);
 m.appendCoverage(coverage({supersedes:gap,details:{recoveredFromReplay:true}}));
 assert.equal(m.coverageRequirement(r).qualified,true);db.close();
});
test('entity creation followed by failed evidence insertion remains financially unqualified after record-link retry',()=>{
 const {db,m}=fixture(),id=m.observe(observation()),identity={namespace:'payment_index' as const,key:'5'};
 db.exec("CREATE TRIGGER fail_link BEFORE INSERT ON canonical_evidence_links BEGIN SELECT RAISE(ABORT,'forced link failure'); END");
 assert.throws(()=>m.identify(id,identity),/forced link failure/);
 const unresolved=m.effects({nodeId:'node-A',network:'mainnet',kind:'payment'});
 assert.equal(unresolved.entities!.length,1);assert.equal(unresolved.entities![0].status,'unresolved');
 assert.deepEqual(unresolved.entities![0].observationIds,[]);assert.deepEqual(unresolved.unresolvedObservationIds,[id]);
 db.exec('DROP TRIGGER fail_link');m.identify(id,identity);
 assert.equal(m.effects({nodeId:'node-A',network:'mainnet',kind:'payment'}).entities![0].status,'unresolved');
 assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);db.close();
});


test('native payment indexes separate repeated hashes, preserve uint64 precision and retain attempt candidates by record',()=>{
 const {db,m}=fixture(),hash='f'.repeat(64);
 const a=m.observe(observation({originalId:'native-1',payload:{payment_hash:hash,payment_index:'9007199254740993'}}));
 const b=m.observe(observation({originalId:'native-2',payload:{payment_hash:hash,payment_index:'9007199254740994'}}));
 const x=m.identify(a,{namespace:'payment_index',key:'9007199254740993'}),y=m.identify(b,{namespace:'payment_index',key:'9007199254740994'});
 assert.notEqual(x.entityId,y.entityId);
 assert.equal((db.prepare('SELECT identity_key FROM canonical_entities WHERE id=?').get(x.entityId) as any).identity_key,'9007199254740993');
 const updated=m.observe(observation({originalId:'updated-attempt',kind:'payment_attempt',payload:{status:'SUCCEEDED'}}));
 const attempt=m.observe(observation({originalId:'initial-attempt',kind:'payment_attempt',payload:{status:'IN_FLIGHT'}}));
 const ai=m.identify(attempt,{namespace:'payment_attempt',key:'9007199254740993:18446744073709551615'});
 assert.equal(m.identify(updated,{namespace:'payment_attempt',key:'09007199254740993:18446744073709551615'}).entityId,ai.entityId);
 assert.notEqual(m.identify(updated,{namespace:'payment_attempt',key:'9007199254740994:18446744073709551615'}).entityId,ai.entityId);
 assert.throws(()=>m.identify(a,{namespace:'payment_index',key:'18446744073709551616'}),/uint64/);
 assert.throws(()=>m.identify(a,{namespace:'payment_index',key:9007199254740993 as any}),/decimal/);
 assert.throws(()=>m.identify(attempt,{namespace:'payment_attempt',key:hash+':1'}),/payment_index/);db.close();
});
test('hash-only correspondence stays ambiguous and forwarding window offsets never qualify effects',()=>{
 const {db,m}=fixture(),hash='a'.repeat(64);
 const a=m.observe(observation({endpointScope:'aggregate',originalId:'hash-1'})),b=m.observe(observation({originalId:'hash-2',sourceChannel:'0x0x3'}));
 const x=m.identify(a,{namespace:'payment_hash',key:hash}),y=m.identify(b,{namespace:'payment_hash',key:hash});
 assert.equal(x.entityId,y.entityId);assert.equal(x.status,'ambiguous');assert.equal(y.status,'ambiguous');
 assert.throws(()=>m.link({observationId:a,entityId:x.entityId,relation:'same_effect',method:'hash-only',details:{}}),/verifier unavailable/);
 assert.equal(m.effects({nodeId:'node-A',network:'mainnet',kind:'payment'}).entities![0].status,'unresolved');
 assert.deepEqual(m.effects({nodeId:'node-A',network:'mainnet',kind:'payment'}).unresolvedObservationIds,[a,b].sort());
 m.link({observationId:a,entityId:x.entityId,referenceTable:'ledger',referenceId:'original-receipt',relation:'booked_receipt',method:'preserved-original',details:{}});
 assert.equal(db.prepare("SELECT reference_id FROM canonical_evidence_links WHERE relation='booked_receipt'").get()?.reference_id,'original-receipt');
 assert.throws(()=>m.identify(a,{namespace:'forward_cursor',key:'window-1:offset-1'}),/window offset/);
 assert.throws(()=>m.identify(b,{namespace:'forward_cursor',key:'window-2:offset-1'}),/window offset/);
 assert.equal(db.prepare("SELECT count(*) n FROM canonical_entities WHERE identity_namespace='forward_cursor'").get()?.n,0);db.close();
});

test('explicit in-transaction projection requires transaction and shares atomic rollback with observations/checkpoint/lineage',()=>{
 const {db,m}=fixture(),input={name:'atomic-projection',scope:'node',epoch:'epoch',calculationVersion:'v1',observationIds:[] as string[],coverageIds:[] as string[],result:{qualified:false}};
 assert.throws(()=>m.publishProjectionInTransaction(input),/active transaction/);
 assert.throws(()=>m.transaction(()=>{const id=m.observe(observation());const checkpoint=m.appendCoverage(coverage({status:'checkpoint',details:{cursor:'1'}}));m.publishProjectionInTransaction({...input,observationIds:[id],coverageIds:[checkpoint]});throw Error('after projection before commit');}),/before commit/);
 for(const table of ['canonical_observations','canonical_coverage','canonical_projection_revisions','canonical_evidence_links'])assert.equal(db.prepare('SELECT count(*) n FROM '+table).get()?.n,0);
 const id=m.observe(observation()),filled={...input,observationIds:[id]};const standalone=m.publishProjection(filled);assert.equal(m.transaction(()=>m.publishProjectionInTransaction(filled)),standalone);assert.equal(db.prepare('SELECT count(*) n FROM canonical_projection_revisions').get()?.n,1);assert.equal(db.prepare("SELECT count(*) n FROM canonical_evidence_links WHERE relation='projection_input'").get()?.n,1);assert.throws(()=>m.transaction(()=>m.publishProjectionInTransaction({...filled,result:{qualified:true}})),/Immutable/);db.close();
});


test('central same-effect guard rejects direct financial qualification and proof-shaped metadata for every native candidate',()=>{
 const {db,m}=fixture();try{for(const [kind,namespace,key] of [['payment','payment_index','7'],['payment_attempt','payment_attempt','7:1'],['native_htlc','htlc_circuit','client-session:1:2:3:4:forward:123']] as const){const id=m.observe(observation({kind,originalId:kind}));const candidate=m.identify(id,{namespace,key});assert.equal(candidate.status,'ambiguous');assert.throws(()=>m.link({observationId:id,entityId:candidate.entityId,relation:'same_effect',method:'verified',details:{identityQualified:true,financialQualified:true,proof:{serverIncarnation:'claimed'}}}),/verifier unavailable/);assert.equal(m.effects({nodeId:'node-A',network:'mainnet',kind}).entities![0].financialQualified,false);}
 assert.equal(db.prepare("SELECT count(*) n FROM canonical_evidence_links WHERE relation='same_effect'").get()?.n,0);
 }finally{db.close();}
});
test('namespace kind meaning and binding spoofing cannot bypass the record guard or turn receipts into financial proof',()=>{
 const {db,m}=fixture();try{const id=m.observe(observation()),candidate=m.identify(id,{namespace:'payment_index',key:'8'});
 assert.throws(()=>m.identify(id,{namespace:'satssurge_operation',key:'operation-claimed'}),/namespace mismatch/);
 assert.throws(()=>m.identify(id,{namespace:'payment_attempt',key:'8:1'}),/namespace mismatch/);
 const intent=m.observe(observation({meaning:'satssurge_intent',kind:'payment',originalId:'intent'}));assert.throws(()=>m.link({observationId:intent,entityId:candidate.entityId,relation:'same_effect',method:'proof',details:{}}),/namespace mismatch/);
 const other=m.observe(observation({network:'testnet'}));assert.throws(()=>m.link({observationId:other,entityId:candidate.entityId,relation:'ambiguous',method:'record_match_v2',details:{}}),/binding mismatch/);
 m.link({observationId:id,entityId:candidate.entityId,referenceTable:'ledger',referenceId:'original-booked-id',relation:'booked_receipt',method:'original-authority',details:{}});
 assert.equal(m.effects({nodeId:'node-A',network:'mainnet',kind:'payment'}).entities![0].status,'unresolved');
 }finally{db.close();}
});
test('old persisted same-effect claims remain byte-identical but are excluded from financial qualification',()=>{
 const {db,m}=fixture();try{const id=m.observe(observation());db.prepare('INSERT INTO canonical_entities VALUES(?,?,?,?,?,?)').run('legacy-entity','node-A','mainnet','payment','payment_index','9');db.prepare('INSERT INTO canonical_evidence_links VALUES(?,?,?,?,?,?,?,?)').run('legacy-link',id,'legacy-entity',null,null,'same_effect','old-index-proof','{"identityQualified":true}');const before=db.prepare('SELECT * FROM canonical_evidence_links').all();const effects=m.effects({nodeId:'node-A',network:'mainnet',kind:'payment'});assert.equal(effects.entities![0].status,'unresolved');assert.equal(effects.entities![0].financialQualified,false);assert.deepEqual(effects.unresolvedObservationIds,[id]);assert.deepEqual(db.prepare('SELECT * FROM canonical_evidence_links').all(),before);
 }finally{db.close();}
});

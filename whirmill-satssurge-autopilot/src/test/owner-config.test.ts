import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseConfig, loadConfig, configChanges, CONFIG } from '../config.js';
import { MANDATE, CHANNEL_MANDATE } from '../domain.js';

test('without a file every value is the built-in one and the mandate is unchanged', () => {
    const none = parseConfig(undefined);
    assert.equal(none.source, 'default'); assert.deepEqual(none.errors, []);
    assert.equal(none.values.mandate.attemptSat, 100); assert.equal(none.values.agent.softSeconds, 120);
    assert.equal(CONFIG.source, 'default');
    assert.equal(MANDATE.attemptMsat, '100000'); assert.equal(MANDATE.dailyMsat, '1500000'); assert.equal(MANDATE.exploratoryDailyMsat, '750000');
    assert.equal(MANDATE.totalMsat, '30000000'); assert.equal(MANDATE.reserveSat, '500000'); assert.equal(MANDATE.feeWindowHours, 48);
    assert.equal(CHANNEL_MANDATE.maxOpenSat, '2000000'); assert.equal(CHANNEL_MANDATE.maxSatPerVbyte, 50);
    assert.equal(MANDATE.configDigest, none.digest);
});

test('a partial file changes only the keys it names', () => {
    const c = parseConfig({ mandate: { attemptSat: 500 }, agent: { softSeconds: 150 } });
    assert.equal(c.source, 'file'); assert.deepEqual(c.errors, []);
    assert.equal(c.values.mandate.attemptSat, 500); assert.equal(c.values.agent.softSeconds, 150);
    assert.equal(c.values.mandate.dailySat, 1500);
    assert.deepEqual(c.overrides, ['mandate.attemptSat', 'agent.softSeconds']);
    assert.notEqual(c.digest, parseConfig(undefined).digest);
    assert.deepEqual(configChanges(undefined, c.values), ['costo massimo per tentativo (sat) 100 → 500', 'durata morbida di un turno chat o analisi (s) 120 → 150']);
});

test('an invalid file applies nothing and names every problem', () => {
    for (const [raw, problem] of [
        [{ mandate: { attemptSat: 5000 } }, /mandate\.attemptSat=5000 fuori dai limiti 1–2000/],
        [{ mandate: { attemptSat: 1.5 } }, /deve essere un numero intero/],
        [{ mandate: { attemptSat: '500' } }, /deve essere un numero intero/],
        [{ mandate: { attempt: 500 } }, /campo sconosciuto: mandate\.attempt/],
        [{ budget: {} }, /sezione sconosciuta: budget/],
        [[1], /oggetto JSON/],
        [{ mandate: { exploratoryDailySat: 2000 } }, /exploratoryDailySat supera mandate\.dailySat/],
        [{ channels: { minOpenSat: 3000000 } }, /minOpenSat supera channels\.maxOpenSat/],
        [{ agent: { softSeconds: 170 } }, /hardSeconds deve superare/],
        [{ lnd: { paymentTimeoutSeconds: 100 } }, /paymentTimeoutSeconds deve stare/],
    ] as const) {
        const c = parseConfig(raw);
        assert.match(c.errors.join('; '), problem as RegExp);
        assert.equal(c.source, 'default'); assert.deepEqual(c.values, parseConfig(undefined).values); assert.deepEqual(c.overrides, []);
    }
    // A valid key next to an invalid one is not applied either.
    assert.equal(parseConfig({ mandate: { attemptSat: 500, dailySat: 0 } }).values.mandate.attemptSat, 100);
});

test('the loader reads the mounted file: missing is fine, broken JSON is an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owner-config-'));
    try {
        assert.deepEqual(loadConfig(join(dir, 'absent.json')).errors, []);
        writeFileSync(join(dir, 'broken.json'), '{ "mandate": ');
        assert.deepEqual(loadConfig(join(dir, 'broken.json')).errors, ['JSON non valido']);
        writeFileSync(join(dir, 'ok.json'), JSON.stringify({ telegram: { proposalMinutes: 10 } }));
        const ok = loadConfig(join(dir, 'ok.json'));
        assert.equal(ok.values.telegram.proposalMinutes, 10); assert.equal(ok.source, 'file');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Starts a fresh process with SATSSURGE_CONFIG_FILE: the configuration is read once at startup. */
function withConfig(content: unknown, extra = '') {
    const dir = mkdtempSync(join(tmpdir(), 'owner-config-run-')), file = join(dir, 'satssurge.json');
    if (content !== undefined) writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    const url = (m: string) => JSON.stringify(new URL('../' + m + '.js', import.meta.url).href);
    const code = `import {Store} from ${url('store')};import {Queue} from ${url('queue')};import {ApplicationControl} from ${url('application-control')};import {Telegram} from ${url('telegram')};import {MANDATE} from ${url('domain')};import {CONFIG} from ${url('config')};
const at=new Date().toISOString(),s=new Store(':memory:'),q=new Queue(s),c=new ApplicationControl(s,q);
s.set('bootstrapReady',true);s.set('automationProof',{ok:true,at});
const ch=(id,alias)=>({id,point:id+':0',peer:id,alias,active:true,capacitySat:'1000000',localSat:'600000',remoteSat:'400000',reserveSat:'5000',pendingSat:'0',baseMsat:'0',ppm:400,cltv:80,minMsat:'1',maxMsat:'1000000000'});
s.saveSnapshot({at,identity:'self',synced:true,confirmedSat:'600000',channels:[ch('a','Don Quixote'),ch('b','LNMarkets')]});
const p={kind:'rebalance',category:'exploratory',strategy:'refill',source:'a',target:'b',amountSat:'250000',maxFeeMsat:'400000',decisionCapMsat:'400000',demandKey:'a->b',evidenceIds:[s.evidence('fixture','observed')],problem:'p',evidence:'e',whyAct:'w',alternatives:'a',verify:'v',hypothesis:'h'};
let dispatch='ok';try{s.assertDispatchReady(at);}catch(e){dispatch=e.message;}
s.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:at});s.set('telegramConfigured',true);
const t=new Telegram(s,c,${JSON.stringify(dir)},{call:async()=>({message_id:1})});${extra}
t.capture(at);t.capture(at);
const out=s.all("SELECT event_id,kind,text FROM telegram_outbox WHERE event_id LIKE 'config:%' OR event_id LIKE 'blockers:%'");t.stop();
console.log(JSON.stringify({attemptMsat:MANDATE.attemptMsat,source:CONFIG.source,errors:CONFIG.errors,blocked:c.blocked(p)??null,unknownEvidence:c.blocked({...p,maxFeeMsat:'100000',decisionCapMsat:'100000',evidenceIds:['950712x1x0']})??null,dispatch,out}));`;
    try {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20000, env: { ...process.env, SATSSURGE_CONFIG_FILE: file } });
        assert.equal(child.status, 0, child.stderr);
        return JSON.parse(child.stdout.trim().split('\n').at(-1)!);
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('with attemptSat 500 a 400 sat rebalance passes the approval check; without it the 100 sat cap refuses it', () => {
    const before = withConfig(undefined);
    assert.equal(before.attemptMsat, '100000'); assert.match(before.blocked, /Fee cap exceeds attempt\/decision limit/);
    assert.equal(before.dispatch, 'ok'); assert.deepEqual(before.out, [], 'no notice without a change');
    assert.equal(before.unknownEvidence, 'Unverified evidence references: 950712x1x0');
    const after = withConfig({ mandate: { attemptSat: 500 } });
    assert.equal(after.attemptMsat, '500000'); assert.equal(after.source, 'file'); assert.equal(after.blocked, null);
    // One owner notice, delivered at any hour, naming the change.
    assert.deepEqual(after.out.map((r: any) => r.kind), ['reply']);
    assert.equal(after.out[0].text, "Configurazione cambiata all'avvio: costo massimo per tentativo (sat) 100 → 500.");
});

test('an invalid file blocks finance and says why on Telegram; chat settings fall back to defaults', () => {
    const r = withConfig({ mandate: { attemptSat: 50000 } });
    assert.equal(r.attemptMsat, '100000');
    assert.match(r.dispatch, /Owner configuration invalid: mandate\.attemptSat=50000 fuori dai limiti/);
    assert.match(r.blocked, /Owner configuration invalid/);
    const blocker = r.out.find((x: any) => x.event_id.startsWith('blockers:'));
    assert.equal(blocker.kind, 'critical');
    assert.match(blocker.text, /Configurazione non valida \(.*satssurge\.json\): mandate\.attemptSat=50000 fuori dai limiti 1–2000\. Operazioni finanziarie bloccate/);
    assert.match(withConfig('not json').dispatch, /JSON non valido/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { ApplicationControl } from '../application-control.js';
import { Telegram, telegramClean } from '../telegram.js';
import { TelegramTurns } from '../telegram-turns.js';
import { hash } from '../domain.js';
import { unsolicitedFixture } from './telegram-unsolicited-fixture.js';

const at = new Date().toISOString(), marker = 'telegramMenu:legacy-owner:null:ownerChatDefaultV2:42';
// Every call uses the production client and its actual JSON parser. Only fetch
// is intercepted, before any network effect, in this process-isolated test file.
function fixture(envelope: (method: string, body: any, attempt: number) => unknown | Promise<unknown>) {
    const directory = mkdtempSync(join(tmpdir(), 'telegram-legacy-')), store = new Store(':memory:'), queue = new Queue(store);
    const control = new ApplicationControl(store, queue), telegram = new Telegram(store, control, directory), turns = new TelegramTurns(store, queue);
    const unsolicited = unsolicitedFixture(store);
    const originalFetch = globalThis.fetch, calls: {method: string; body: any}[] = [];
    writeFileSync(telegram.tokenPath, 'offline-fixture-never-a-token', {mode:0o600});
    globalThis.fetch = async (input, options) => {
        const url = new URL(String(input)); assert.equal(url.origin, 'https://api.telegram.org'); assert.equal(options?.method, 'POST');
        const method = url.pathname.split('/').at(-1)!, body = options!.body instanceof FormData ? options!.body : JSON.parse(String(options!.body));
        const acknowledgement = await unsolicited.acknowledge(method, body);
        let result: unknown;
        if (acknowledgement) result = {ok:true,result:acknowledgement};
        else { calls.push({method,body}); result = await envelope(method, body, calls.length); }
        return new Response(JSON.stringify(result), {status:200,headers:{'content-type':'application/json'}});
    };
    store.set('bootstrapReady',true); store.set('telegramConfigured',true);
    store.set('telegramBinding',{generation:'legacy-owner',chatId:42,userId:42,since:new Date(Date.parse(at)-60000).toISOString()});
    return {unsolicited,store,telegram,calls,complete(answer='# Dati pubblici\n\n- Ricevuta esatta 😀') {
        const job=control.admit('legacy','Spiega i dati pubblici','telegram'); turns.attach(job,'legacy-owner',42);store.set('jobTelegramGeneration:'+job.id,'legacy-owner');
        const claimed=queue.claim('coordinator','envelope-test',at)!;queue.finish(job.id,claimed.run_token!,'completed',{answer},at);turns.finalize(job.id,'completed');telegram.capture(at);return 'answer:'+job.id;
    },close(){unsolicited.verify();globalThis.fetch=originalFetch;telegram.stop();store.close();rmSync(directory,{recursive:true,force:true});}};
}


const overflow = Array(501).fill('# H').join('\n');
const uncertain: [string,unknown][] = [
    ['server500',{ok:false,error_code:500}], ['unclassified499',{ok:false,error_code:499}], ['missing_code',{ok:false}]
];
for(const [name,envelope] of uncertain)for(const knownFirst of [0,4])test('production overflow final '+name+' is uncertain after '+knownFirst+' real denials with no replay',async()=>{
    const f=fixture((_method,_body,attempt)=>attempt<=knownFirst?{ok:false,error_code:403}:envelope);try{
        assert.equal(overflow.length,2003);const event=f.complete(overflow),original=f.store.one('SELECT text,generation FROM telegram_outbox WHERE event_id=?',event);
        assert.equal(original.text,overflow);assert.equal(f.store.get('telegramRichFinal:'+event),undefined);
        for(const seconds of [0,3,8,17,34].slice(0,knownFirst+1))await f.telegram.deliver(new Date(Date.parse(at)+seconds*1000).toISOString());
        const row=f.store.one('SELECT * FROM telegram_outbox WHERE event_id=?',event);
        assert.equal(row.status,'uncertain');assert.equal(row.attempts,knownFirst+1);assert.equal(row.message_id,null);assert.match(row.error,/Delivery uncertain/);
        assert.equal(f.store.get('telegramRichFinalFallback:'+event),undefined);assert.equal(f.store.get('telegramRateLimitUntil'),undefined);
        f.telegram.recover();await f.telegram.deliver(new Date(Date.parse(at)+1000000).toISOString());
        assert.deepEqual(f.calls.map(c=>c.method),Array(knownFirst+1).fill('sendMessage'));assert.deepEqual(f.store.one('SELECT * FROM telegram_outbox WHERE event_id=?',event),row);
        assert.equal(f.store.one('SELECT text FROM telegram_outbox WHERE event_id=?',event).text,original.text);
    }finally{f.close();}
});
for(const [name,envelope] of uncertain)test('production ordinary persistent reply '+name+' is uncertain without replay',async()=>{
    const f=fixture(()=>envelope);try{
        f.telegram.enqueue('ordinary-reply','Testo pubblico 😀','reply',undefined,at);await f.telegram.deliver(at);
        const row=f.store.one("SELECT * FROM telegram_outbox WHERE event_id='ordinary-reply'");assert.equal(row.status,'uncertain');assert.equal(row.attempts,1);assert.match(row.error,/Delivery uncertain/);
        f.telegram.recover();await f.telegram.deliver(new Date(Date.parse(at)+1000000).toISOString());assert.deepEqual(f.calls.map(c=>c.method),['sendMessage']);assert.deepEqual(f.store.one("SELECT * FROM telegram_outbox WHERE event_id='ordinary-reply'"),row);
    }finally{f.close();}
});
test('production oversized legacy multipart preserves intent and never replays uncertain parts',async()=>{
    const f=fixture(()=>({ok:false,error_code:500}));try{
        const answer=('Paragrafo pubblico 😀 senza effetti finanziari.\n\n').repeat(800),event=f.complete(answer);
        const before=f.store.all('SELECT * FROM telegram_outbox WHERE event_id=? OR event_id LIKE ? ORDER BY rowid',event,event+':part:%');assert.ok(before.length>1);assert.equal(before.map(r=>r.text).join(''),telegramClean(answer));assert.ok(before.every(r=>f.store.get('telegramRichFinal:'+r.event_id)===undefined));
        await f.telegram.deliver(at);const after=f.store.all('SELECT * FROM telegram_outbox WHERE event_id=? OR event_id LIKE ? ORDER BY rowid',event,event+':part:%');
        assert.ok(after.every(r=>r.status==='uncertain'&&r.attempts===1));assert.equal(after.map(r=>r.text).join(''),telegramClean(answer));assert.equal(f.calls.length,before.length);assert.ok(f.calls.every(c=>c.method==='sendMessage'));
        f.telegram.recover();await f.telegram.deliver(new Date(Date.parse(at)+1000000).toISOString());assert.equal(f.calls.length,before.length);assert.deepEqual(f.store.all('SELECT * FROM telegram_outbox WHERE event_id=? OR event_id LIKE ? ORDER BY rowid',event,event+':part:%'),after);
    }finally{f.close();}
});
test('historical legacy final intent remains unformatted and uncertain after production server failure',async()=>{
    const f=fixture(()=>({ok:false,error_code:500}));try{
        const event=f.complete('# Risposta precedente\n\nTesto canonico conservato 😀');f.store.run('DELETE FROM meta WHERE key=?','telegramRichFinal:'+event);
        const bytes=f.store.one('SELECT text FROM telegram_outbox WHERE event_id=?',event).text;
        f.telegram.capture(at);assert.equal(f.store.get('telegramRichFinal:'+event),undefined);await f.telegram.deliver(at);assert.equal(f.store.one('SELECT status FROM telegram_outbox WHERE event_id=?',event).status,'uncertain');
        f.telegram.recover();await f.telegram.deliver(new Date(Date.parse(at)+1000000).toISOString());assert.deepEqual(f.calls.map(c=>c.method),['sendMessage']);assert.equal(f.store.one('SELECT text FROM telegram_outbox WHERE event_id=?',event).text,bytes);assert.equal(f.store.get('telegramRichFinal:'+event),undefined);
    }finally{f.close();}
});
for(const apiCode of [400,404])test('production legacy '+apiCode+' retries same canonical bytes only after known rejection',async()=>{
    const f=fixture((_method,_body,attempt)=>attempt===1?{ok:false,error_code:apiCode}:{ok:true,result:{message_id:51}});try{
        const event=f.complete(overflow);await f.telegram.deliver(at);assert.equal(f.store.one('SELECT status FROM telegram_outbox WHERE event_id=?',event).status,'pending');assert.equal(f.store.get('telegramRichFinalFallback:'+event),undefined);
        await f.telegram.deliver(at);assert.equal(f.calls.length,1);await f.telegram.deliver(new Date(Date.parse(at)+3000).toISOString());assert.deepEqual(f.calls.map(c=>c.method),['sendMessage','sendMessage']);assert.equal(f.calls[0]!.body.text,f.calls[1]!.body.text);assert.equal(f.store.one('SELECT status,message_id FROM telegram_outbox WHERE event_id=?',event).status,'sent');assert.equal(f.store.one('SELECT message_id FROM telegram_outbox WHERE event_id=?',event).message_id,51);
    }finally{f.close();}
});
test('production legacy 429 retains shared quota and next bounded attempt',async()=>{
    const f=fixture((_method,_body,attempt)=>attempt===1?{ok:false,error_code:429,parameters:{retry_after:120}}:{ok:true,result:{message_id:52}});try{
        const event=f.complete(overflow);await f.telegram.deliver(at);assert.equal(f.store.one('SELECT status FROM telegram_outbox WHERE event_id=?',event).status,'pending');assert.ok(f.store.get<number>('telegramRateLimitUntil')!>Date.now());await f.telegram.deliver(at);assert.equal(f.calls.length,1);
        f.store.set('telegramRateLimitUntil',0);await f.telegram.deliver(new Date(Date.parse(at)+121000).toISOString());assert.deepEqual(f.calls.map(c=>c.method),['sendMessage','sendMessage']);assert.equal(f.store.one('SELECT status FROM telegram_outbox WHERE event_id=?',event).status,'sent');
    }finally{f.close();}
});
test('production legacy five proven denials exhaust bounded retries',async()=>{
    const f=fixture(()=>({ok:false,error_code:403}));try{
        const event=f.complete(overflow);for(const seconds of [0,3,8,17,34])await f.telegram.deliver(new Date(Date.parse(at)+seconds*1000).toISOString());assert.equal(f.store.one('SELECT status,attempts FROM telegram_outbox WHERE event_id=?',event).status,'failed');assert.equal(f.store.one('SELECT attempts FROM telegram_outbox WHERE event_id=?',event).attempts,5);await f.telegram.deliver(new Date(Date.parse(at)+1000000).toISOString());assert.equal(f.calls.length,5);
    }finally{f.close();}
});

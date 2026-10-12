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

const at = new Date().toISOString(), marker = 'telegramMenu:envelope-owner:null:ownerChatDefaultV1:42';
async function responseMethods(calls: {method: string; body: any}[], store: Store) {
    // Exclude only a separately correlated scanner artifact, never a response
    // document. This stays valid before and after Rome's quiet-hours boundary.
    const methods: string[] = [];
    for (const call of calls) {
        const document = call.method === 'sendDocument' && call.body instanceof FormData ? call.body.get('document') as File : undefined;
        if (document && /^satssurge-[a-f0-9]{16}-r\d+\.txt$/.test(document.name)) {
            const artifact = store.all("SELECT value FROM meta WHERE key LIKE 'runtimeArtifact:advisory:%'").map(row => JSON.parse(row.value)).find(a => a.filename === document.name);
            assert.ok(artifact, 'unrelated document must have its own immutable advisory receipt');
            assert.equal(hash(await document.text()), artifact.checksum); assert.equal(call.body.get('chat_id'), String(artifact.chatId));
        } else methods.push(call.method);
    }
    return methods;
}
// Every call uses the production client and its actual JSON parser. Only fetch
// is intercepted, before any network effect, in this process-isolated test file.
function fixture(envelope: (method: string, body: any, attempt: number) => unknown | Promise<unknown>) {
    const directory = mkdtempSync(join(tmpdir(), 'telegram-envelope-')), store = new Store(':memory:'), queue = new Queue(store);
    const control = new ApplicationControl(store, queue), telegram = new Telegram(store, control, directory), turns = new TelegramTurns(store, queue);
    const originalFetch = globalThis.fetch, calls: {method: string; body: any}[] = [];
    writeFileSync(telegram.tokenPath, 'offline-fixture-never-a-token', {mode:0o600});
    globalThis.fetch = async (input, options) => {
        const url = new URL(String(input)); assert.equal(url.origin, 'https://api.telegram.org'); assert.equal(options?.method, 'POST');
        const method = url.pathname.split('/').at(-1)!, body = options!.body instanceof FormData ? options!.body : JSON.parse(String(options!.body));
        calls.push({method,body}); const result = await envelope(method, body, calls.length);
        return new Response(JSON.stringify(result), {status:200,headers:{'content-type':'application/json'}});
    };
    store.set('bootstrapReady',true); store.set('telegramConfigured',true);
    store.set('telegramBinding',{generation:'envelope-owner',chatId:42,userId:42,since:new Date(Date.parse(at)-60000).toISOString()});
    return {store,telegram,calls,complete(answer='# Dati pubblici\n\n- Ricevuta esatta 😀') {
        const job=control.admit('envelope','Spiega i dati pubblici','telegram'); turns.attach(job,'envelope-owner',42);store.set('jobTelegramGeneration:'+job.id,'envelope-owner');
        const claimed=queue.claim('coordinator','envelope-test',at)!;queue.finish(job.id,claimed.run_token!,'completed',{answer},at);turns.finalize(job.id,'completed');telegram.capture(at);return 'answer:'+job.id;
    },close(){globalThis.fetch=originalFetch;telegram.stop();store.close();rmSync(directory,{recursive:true,force:true});}};
}

const malformed: [string,unknown][] = [
    ['missing_known400',{error_code:400}], ['zero_known404',{ok:0,error_code:404}], ['null_known400',{ok:null,error_code:400}],
    ['string_false_error',{ok:'false',error_code:400}], ['truthy_false_success',{ok:'false',result:{message_id:31}}],
    ['truthy_true_success',{ok:'true',result:{message_id:31}}], ['numeric_success',{ok:1,result:{message_id:31}}],
    ['missing_ok_retry',{error_code:429,parameters:{retry_after:120}}], ['array',[]], ['null',null], ['string','false'], ['number',0], ['boolean',false]
];
for (const [name,envelope] of malformed) for (const attempts of [0,4]) test('production envelope '+name+' remains uncertain on attempt '+(attempts+1)+' without fallback or replay',async()=>{
    const f=fixture(()=>envelope);try{
        const event=f.complete(),composition=f.store.one('SELECT value FROM meta WHERE key=?','telegramRichFinal:'+event).value;f.store.run('UPDATE telegram_outbox SET attempts=? WHERE event_id=?',attempts,event);
        await f.telegram.deliver(at);const row=f.store.one('SELECT * FROM telegram_outbox WHERE event_id=?',event);
        assert.equal(row.status,'uncertain');assert.equal(row.attempts,attempts+1);assert.equal(row.message_id,null);assert.match(row.error,/Delivery uncertain/);
        assert.equal(f.store.get('telegramRichFinalFallback:'+event),undefined);assert.equal(f.store.get('telegramRateLimitUntil'),undefined);
        f.telegram.recover();f.telegram.capture(at);await f.telegram.deliver(new Date(Date.parse(at)+1000000).toISOString());
        assert.deepEqual(await responseMethods(f.calls,f.store),['sendRichMessage']);assert.deepEqual(f.store.one('SELECT * FROM telegram_outbox WHERE event_id=?',event),row);assert.equal(f.store.one('SELECT value FROM meta WHERE key=?','telegramRichFinal:'+event).value,composition);
    }finally{f.close();}
});

for(const [name,envelope] of malformed)test('production client '+name+' never grants rejection fields from a malformed envelope',async()=>{
    const f=fixture(()=>envelope);try{await assert.rejects((f.telegram as any).client().call('getMe',{}),(error:any)=>{assert.equal(error.rejected,undefined);assert.equal(error.apiCode,undefined);assert.equal(error.retryAfter,undefined);assert.match(error.message,/delivery may be uncertain/);return true;});assert.equal(f.calls.length,1);}finally{f.close();}
});

for(const during of [1,2,3,4])test('menu truthy nonboolean envelope at ACK '+during+' cannot commit completion',async()=>{
    const f=fixture((method,_body,attempt)=>({ok:attempt===during?'false':true,result:method==='getMe'?{username:'satssurge_bot'}:true}));try{
        await assert.rejects(f.telegram.menu(),/delivery may be uncertain/);assert.equal(f.calls.length,during);assert.equal(f.store.get(marker),undefined);assert.equal(f.store.get('telegramUsername'),undefined);
    }finally{f.close();}
});

for(const apiCode of [400,404])test('valid boolean false production '+apiCode+' admits the exact document only on the next bounded attempt',async()=>{
    const f=fixture(method=>method==='sendRichMessage'?{ok:false,error_code:apiCode}:{ok:true,result:{message_id:32}});try{
        const answer='# Dati pubblici\n\n- Ricevuta esatta 😀',event=f.complete(answer);await f.telegram.deliver(at);
        assert.equal(f.store.one('SELECT status FROM telegram_outbox WHERE event_id=?',event).status,'pending');assert.equal(f.store.get<any>('telegramRichFinalFallback:'+event).apiCode,apiCode);assert.deepEqual(f.calls.map(c=>c.method),['sendRichMessage']);
        await f.telegram.deliver(at);assert.equal(f.calls.length,1);await f.telegram.deliver(new Date(Date.parse(at)+3000).toISOString());assert.deepEqual(f.calls.map(c=>c.method),['sendRichMessage','sendDocument']);
        const document=f.calls[1]!.body.get('document') as File;assert.equal(await document.text(),telegramClean(answer));assert.equal(hash(await document.text()),hash(telegramClean(answer)));assert.equal(f.calls[1]!.body.get('chat_id'),'42');assert.equal(f.store.one('SELECT status,message_id FROM telegram_outbox WHERE event_id=?',event).status,'sent');
    }finally{f.close();}
});

test('valid boolean success production rich acknowledgement is recorded once',async()=>{
    const f=fixture(()=>({ok:true,result:{message_id:33}}));try{const event=f.complete();await f.telegram.deliver(at);assert.equal(f.store.one('SELECT status,message_id FROM telegram_outbox WHERE event_id=?',event).status,'sent');assert.equal(f.store.one('SELECT message_id FROM telegram_outbox WHERE event_id=?',event).message_id,33);f.telegram.capture(at);await f.telegram.deliver(at);assert.equal(f.calls.length,1);}finally{f.close();}
});

test('valid boolean production menu acknowledgements commit both owner scopes once',async()=>{
    const f=fixture(method=>({ok:true,result:method==='getMe'?{username:'satssurge_bot'}:true}));try{await f.telegram.menu();await f.telegram.menu();assert.deepEqual(f.calls.map(c=>c.method),['setMyCommands','setMyCommands','setChatMenuButton','getMe']);assert.equal(f.store.get(marker),true);assert.equal(f.calls[0]!.body.language_code,undefined);assert.equal(f.calls[1]!.body.language_code,'it');assert.ok(f.calls.slice(0,2).every(c=>c.body.scope.type==='chat'&&c.body.scope.chat_id===42));}finally{f.close();}
});

test('valid production boolean false 429 retains shared cooldown without document fallback',async()=>{
    const f=fixture(()=>({ok:false,error_code:429,parameters:{retry_after:120}}));try{const event=f.complete();await f.telegram.deliver(at);assert.equal(f.store.one('SELECT status FROM telegram_outbox WHERE event_id=?',event).status,'pending');assert.equal(f.store.get('telegramRichFinalFallback:'+event),undefined);assert.ok(f.store.get<number>('telegramRateLimitUntil')!>Date.now());await f.telegram.deliver(at);assert.equal(f.calls.length,1);}finally{f.close();}
});

for(const malformedFifth of [{error_code:400},{ok:'false',result:{message_id:35}}])test('four actual production rejections then malformed fifth outcome remain uncertain beyond retry budget '+(malformedFifth.ok?'positive':'denial'),async()=>{
    const f=fixture((_method,_body,attempt)=>attempt<=4?{ok:false,error_code:403}:malformedFifth);try{
        const event=f.complete();for(const seconds of [0,3,8,17,34])await f.telegram.deliver(new Date(Date.parse(at)+seconds*1000).toISOString());
        const row=f.store.one('SELECT status,attempts,message_id FROM telegram_outbox WHERE event_id=?',event);assert.equal(row.status,'uncertain');assert.equal(row.attempts,5);assert.equal(row.message_id,null);assert.equal(f.store.get('telegramRichFinalFallback:'+event),undefined);
        f.telegram.recover();await f.telegram.deliver(new Date(Date.parse(at)+1000000).toISOString());assert.deepEqual(f.calls.map(c=>c.method),Array(5).fill('sendRichMessage'));
    }finally{f.close();}
});

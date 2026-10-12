import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { ApplicationControl } from '../application-control.js';
import { Telegram, telegramClean, telegramHtml, telegramRichHtml } from '../telegram.js';
import { TelegramTurns } from '../telegram-turns.js';
import { UiEvents } from '../ui-events.js';
import { hash } from '../domain.js';
import { unsolicitedFixture } from './telegram-unsolicited-fixture.js';

const at = new Date().toISOString();

const commandNames = ['status','analyze','proposals','pause','resume','stop','queue','recover','prompt','menu','help'];
function fixture(call: (method: string, body: any) => Promise<any> = async method => method === 'getMe' ? { username: 'satssurge_bot' } : true) {
    const directory = mkdtempSync(join(tmpdir(), 'rich-layout-')), store = new Store(':memory:'), queue = new Queue(store);
    const unsolicited = unsolicitedFixture(store);
    const control = new ApplicationControl(store, queue), telegram = new Telegram(store, control, directory, { call: async (method, body) => await unsolicited.acknowledge(method, body) ?? call(method, body) }), turns = new TelegramTurns(store, queue);
    store.set('bootstrapReady', true); store.set('telegramConfigured', true);
    store.set('telegramBinding', { generation: 'layout-owner', chatId: 42, userId: 42, since: new Date(Date.parse(at) - 60000).toISOString() });
    return { unsolicited, store, queue, telegram, turns, open() {
        const job = control.admit('layout', 'Spiega i dati pubblici', 'telegram'); turns.attach(job, 'layout-owner', 42);
        store.set('jobTelegramGeneration:' + job.id, 'layout-owner');
        const claimed = queue.claim('coordinator', 'layout-test', at)!; turns.bind(claimed, { steer: async () => {}, stop: async () => {} }); return { job, claimed };
    }, complete(answer: string) { const { job, claimed } = this.open(); queue.finish(job.id, claimed.run_token!, 'completed', { answer }, at); turns.finalize(job.id, 'completed'); return job; },
    close() { unsolicited.verify(); telegram.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('new rich final emits headings, paragraphs, line breaks and real list blocks without changing canonical text', async () => {
    const calls: any[] = [], f = fixture(async (method, body) => { calls.push({ method, body }); return { message_id: 12 }; });
    try {
        const answer = '# Situazione\n\nRiga pubblica 😀.\nSeconda riga.\n\n## Evidenza\n\n- Un dato\n- Un altro dato\n\n1. Primo passo\n3. Terzo passo\n\n```txt\n<unsafe> & **literal**\n```';
        const job = f.complete(answer), event = 'answer:' + job.id; f.telegram.capture(at); await f.telegram.deliver(at);
        const html = calls.find(c => c.method === 'sendRichMessage').body.rich_message.html;
        assert.match(html, /<h1>Situazione<\/h1>/); assert.match(html, /<h2>Evidenza<\/h2>/);
        assert.match(html, /<p>Riga pubblica 😀\.<br>Seconda riga\.<\/p>/);
        assert.match(html, /<ul><li>/); assert.match(html, /<ol><li value="1">/); assert.match(html, /<li value="3">/);
        assert.match(html, /<pre><code>&lt;unsafe&gt; &amp; \*\*literal\*\*\n<\/code><\/pre>/);
        assert.equal(f.store.one('SELECT text FROM telegram_outbox WHERE event_id=?', event).text, telegramClean(answer));
        assert.equal(f.store.get<any>('telegramRichFinal:' + event).checksum, hash(telegramClean(answer)));
    } finally { f.close(); }
});

test('cached old menu upgrades owner default and Italian scopes while preserving global and inherited scopes', async () => {
    const calls: any[] = [], scopes = new Map<string, any>([['default', ['global']], ['all_private_chats', ['legacy']], ['chat:43', ['unrelated']]]);
    const f = fixture(async (method, body) => { calls.push({ method, body }); if (method === 'setMyCommands') scopes.set(body.scope ? body.scope.type + ':' + body.scope.chat_id + ':' + (body.language_code ?? '') : 'default', body.commands); return method === 'getMe' ? { username: 'satssurge_bot' } : true; });
    try {
        const key = 'telegramMenu:layout-owner:null'; for (const suffix of ['', ':recoveryReviewV1', ':promptRetrievalV1']) f.store.set(key + suffix, true);
        await f.telegram.menu(); await f.telegram.menu();
        const writes = calls.filter(c => c.method === 'setMyCommands'); assert.equal(writes.length, 2);
        assert.deepEqual(writes.map(c => c.body.scope), [{ type: 'chat', chat_id: 42 }, { type: 'chat', chat_id: 42 }]);
        assert.equal(writes[0].body.language_code, undefined); assert.equal(writes[1].body.language_code, 'it');
        assert.deepEqual(writes[0].body.commands.map((c: any) => c.command), commandNames);
        assert.deepEqual(scopes.get('default'), ['global']); assert.deepEqual(scopes.get('all_private_chats'), ['legacy']); assert.deepEqual(scopes.get('chat:43'), ['unrelated']);
        assert.equal(calls.length, 4); assert.equal(f.store.get(key + ':ownerChatDefaultV1:42'), true);
    } finally { f.close(); }
});

function htmlStats(html: string) {
    let depth = 0, maxDepth = 0, blocks = 0;
    for (const match of html.matchAll(/<(\/)?([a-z][a-z0-9-]*)(?: [^>]*)?>/g)) {
        const closing = !!match[1], tag = match[2]!; if (tag === 'br') continue;
        if (closing) depth--; else { depth++; maxDepth = Math.max(maxDepth, depth); if (/^(p|h[1-6]|ul|ol|li|pre|tg-thinking)$/.test(tag)) blocks++; }
        assert.ok(depth >= 0);
    }
    assert.equal(depth, 0); return { maxDepth, blocks };
}

test('legacy inline serializer stays byte-identical while rich formatter emits bounded safe blocks and opaque code', () => {
    assert.equal(telegramHtml('# Titolo\n\n**forte** e `codice` <h1>x</h1> &'), '<b>Titolo</b>\n\n<b>forte</b> e <code>codice</code> &lt;h1&gt;x&lt;/h1&gt; &amp;');
    const source = Array.from({length:6},(_,i)=>'#'.repeat(i+1)+' Sezione '+(i+1)).join('\n\n') + '\n\n<p>raw</p> [link](https://invalid.example) ![image](https://invalid.example)\n`**literal** <img src="x">` e **forte**.\n\n```html\n<h1>raw</h1>\n**literal** & `code`\n```';
    const html = telegramRichHtml(source); for (let i=1;i<=6;i++) assert.match(html,new RegExp('<h'+i+'>Sezione '+i+'</h'+i+'>'));
    assert.match(html, /&lt;p&gt;raw&lt;\/p&gt;/); assert.match(html, /<code>\*\*literal\*\* &lt;img/);
    assert.match(html, /<pre><code>&lt;h1&gt;raw&lt;\/h1&gt;\n\*\*literal\*\* &amp; `code`\n<\/code><\/pre>/);
    assert.doesNotMatch(html, /<(img|a|script|iframe|tg-button)\b/); assert.ok(htmlStats(html).maxDepth <= 4);
});

test('new rich metadata records format and conservative block/depth bounds', async () => {
    const f = fixture(async()=>({message_id:13})); try {
        const source = '# Stato\n\nTesto pubblico.\n\n- Primo\n- Secondo', job = f.complete(source); f.telegram.capture(at);
        const meta = f.store.get<any>('telegramRichFinal:answer:'+job.id), stats=htmlStats(telegramRichHtml(source));
        assert.equal(meta.format,'rich-blocks-v1'); assert.equal(meta.blocks,stats.blocks); assert.ok(meta.depth>=stats.maxDepth); assert.ok(meta.depth<=16); assert.ok(meta.blocks<=500);
        assert.equal(meta.htmlBytes,Buffer.byteLength(telegramRichHtml(source),'utf8')); await f.telegram.deliver(at);
    } finally { f.close(); }
});

for (const change of ['unknown-format','null-format','blocks','depth','htmlBytes']) test('rich metadata '+change+' fails closed without dispatch or fallback',async()=>{
    let calls=0;const f=fixture(async()=>{calls++;return {message_id:14};});try{
        const job=f.complete('# Stato\n\nUn dato.'),event='answer:'+job.id;f.telegram.capture(at);const key='telegramRichFinal:'+event,meta=f.store.get<any>(key);
        f.store.set(key,{...meta,...(change==='unknown-format'?{format:'rich-blocks-v999'}:change==='null-format'?{format:null}:change==='blocks'?{blocks:501}:change==='depth'?{depth:17}:{htmlBytes:meta.htmlBytes+1})});
        await f.telegram.deliver(at);assert.equal(calls,0);assert.equal(f.store.one('SELECT status,attempts FROM telegram_outbox WHERE event_id=?',event).status,'failed');assert.equal(f.store.one('SELECT attempts FROM telegram_outbox WHERE event_id=?',event).attempts,0);assert.equal(f.store.get('telegramRichFinalFallback:'+event),undefined);
    }finally{f.close();}
});

for(const fallback of [false,true])test('unversioned 0.5.11 intent retains exact old serializer and immutable metadata '+(fallback?'through document fallback':'at rich dispatch'),async()=>{
    const calls:any[]=[],f=fixture(async(method,body)=>{calls.push({method,body});return {message_id:15};});try{
        const answer='# Originale\n\n- Vecchio elenco\nSeconda riga.',job=f.complete(answer),event='answer:'+job.id;f.telegram.capture(at);
        const old={generation:'layout-owner',chatId:42,botGeneration:null,checksum:hash(telegramClean(answer)),htmlBytes:Buffer.byteLength(telegramHtml(answer),'utf8')};
        f.store.set('telegramRichFinal:'+event,old);if(fallback)f.store.set('telegramRichFinalFallback:'+event,{...old,apiCode:400});
        const bytes=f.store.one('SELECT value FROM meta WHERE key=?','telegramRichFinal:'+event).value;
        f.telegram.capture(at);await f.telegram.deliver(at);assert.equal(calls.length,1);
        if(fallback){assert.equal(calls[0].method,'sendDocument');assert.equal(await (calls[0].body.get('document') as File).text(),telegramClean(answer));}else assert.deepEqual(calls[0].body.rich_message,{html:telegramHtml(answer)});
        assert.equal(f.store.one('SELECT value FROM meta WHERE key=?','telegramRichFinal:'+event).value,bytes);assert.equal(f.store.one('SELECT status FROM telegram_outbox WHERE event_id=?',event).status,'sent');
        f.telegram.capture(at);await f.telegram.deliver(at);assert.equal(calls.length,1);
    }finally{f.close();}
});

test('500-block boundary counts each list item and nested paragraph; over-bound finals preserve all text in legacy delivery',()=>{
    for(const count of [249,250]){const f=fixture();try{
        const answer=Array(count).fill('- Dato').join('\n'),job=f.complete(answer),event='answer:'+job.id;f.telegram.capture(at);
        const rows=f.store.all('SELECT text FROM telegram_outbox WHERE event_id=? OR event_id LIKE ? ORDER BY rowid',event,event+':%');assert.equal(rows.map(r=>r.text).join(''),telegramClean(answer));
        const meta=f.store.get<any>('telegramRichFinal:'+event);if(count===249){assert.equal(meta.blocks,499);assert.ok(meta.depth<=16);}else assert.equal(meta,undefined);
    }finally{f.close();}}
});

test('rich draft uses structured blocks, while local block-bound overflow selects plain draft before any rich send',async()=>{
    for(const overflow of [false,true]){const calls:any[]=[],f=fixture(async(method,body)=>{calls.push({method,body});return true;});try{
        const {job}=f.open(),text=overflow?Array(250).fill('- a').join('\n'):'# Anteprima\n\nPrima riga.\nSeconda riga.\n\n- Dato';new UiEvents(f.store).append(job.id,'text',{text});await f.telegram.streamDrafts(at);
        assert.equal(calls.length,1);assert.equal(calls[0].method,overflow?'sendMessageDraft':'sendRichMessageDraft');assert.equal(calls[0].body.can_stop,true);assert.equal(calls[0].body.keep_on_stop,true);
        const alias=f.store.get<any>('telegramDraft:'+calls[0].body.draft_id);assert.equal(alias.jobId,job.id);assert.equal(alias.version,f.turns.get(job.id)!.version);
        if(overflow){assert.equal(calls[0].body.text,text);assert.equal(f.store.get<any>('telegramStream:'+job.id).plainDraft,true);}else assert.match(calls[0].body.rich_message.html,/<h1>Anteprima<\/h1>/);
    }finally{f.close();}}
});

test('simultaneous menu requests commit one migration and repeated calls do not dispatch',async()=>{
    const calls:any[]=[],f=fixture(async(method,body)=>{calls.push({method,body});await Promise.resolve();return method==='getMe'?{username:'satssurge_bot'}:true;});try{await Promise.all([f.telegram.menu(),f.telegram.menu()]);await f.telegram.menu();assert.equal(calls.length,4);}finally{f.close();}
});

for(const during of [1,2,3,4])for(const change of ['revoke','rebind','chat','bot','rate'])test('menu '+change+' during ACK '+during+' fences subsequent calls and durable completion',async()=>{
    let calls=0;const f=fixture(async method=>{if(++calls===during){if(change==='revoke')f.telegram.revoke();else if(change==='rate')f.store.set('telegramRateLimitUntil',Date.now()+60000);else if(change==='bot')f.store.set('telegramBotGeneration','replacement');else f.store.set('telegramBinding',{...f.store.get<any>('telegramBinding'),...(change==='chat'?{chatId:43}:{generation:'replacement'})});}return method==='getMe'?{username:'satssurge_bot'}:true;});
    try{await f.telegram.menu();assert.equal(calls,during);assert.equal(f.store.get('telegramMenu:layout-owner:null:ownerChatDefaultV1:42'),undefined);assert.equal(f.store.get('telegramUsername'),undefined);}finally{f.close();}
});

for(const during of [1,2,3,4])test('menu missing ACK '+during+' does not mark migration complete and retries idempotent registration',async()=>{
    const calls:any[]= [];let reject=true;const f=fixture(async(method,body)=>{calls.push({method,body});if(reject&&calls.length===during)return {};return method==='getMe'?{username:'satssurge_bot'}:true;});try{
        await assert.rejects(f.telegram.menu(),/acknowledgement missing/);assert.equal(calls.length,during);assert.equal(f.store.get('telegramMenu:layout-owner:null:ownerChatDefaultV1:42'),undefined);
        reject=false;await f.telegram.menu();assert.equal(calls.length,during+4);assert.equal(f.store.get('telegramMenu:layout-owner:null:ownerChatDefaultV1:42'),true);
    }finally{f.close();}
});

test('menu 429 preserves global rate epoch, stops migration and resumes owner scopes only after cooldown',async()=>{
    const calls:any[]=[];let rejected=false;const f=fixture(async(method,body)=>{calls.push({method,body});if(!rejected&&calls.length===2){rejected=true;throw Object.assign(Error('known rate rejection'),{rejected:true,apiCode:429,retryAfter:120});}return method==='getMe'?{username:'satssurge_bot'}:true;});try{
        await assert.rejects(f.telegram.menu(),/rate rejection/);assert.equal(calls.length,2);assert.ok(f.store.get<number>('telegramRateLimitUntil')!>Date.now());assert.equal(f.store.get('telegramMenu:layout-owner:null:ownerChatDefaultV1:42'),undefined);
        await f.telegram.menu();assert.equal(calls.length,2);f.store.set('telegramRateLimitUntil',Date.now()-1);await f.telegram.menu();assert.equal(calls.length,6);assert.ok(calls.filter(c=>c.method==='setMyCommands').every(c=>c.body.scope.type==='chat'&&c.body.scope.chat_id===42));
    }finally{f.close();}
});

test('500 shallow heading blocks qualify and 501 use exact canonical legacy parts',()=>{
    for(const count of [500,501]){const f=fixture();try{const answer=Array(count).fill('# H').join('\n'),job=f.complete(answer),event='answer:'+job.id;f.telegram.capture(at);const meta=f.store.get<any>('telegramRichFinal:'+event);assert.equal(meta?.blocks,count===500?500:undefined);assert.equal(f.store.all('SELECT text FROM telegram_outbox WHERE event_id=? OR event_id LIKE ? ORDER BY rowid',event,event+':%').map(r=>r.text).join(''),answer);}finally{f.close();}}
});

test('thinking rich block keeps only allowlisted public summary, escaped line breaks, and nonempty fallback',async()=>{
    const calls:any[]=[],f=fixture(async(method,body)=>{calls.push({method,body});return true;});try{
        const {job}=f.open(),ui=new UiEvents(f.store);ui.append(job.id,'reasoning_summary',{text:'<img src="private">',provenance:'private'});ui.append(job.id,'reasoning_summary',{text:'   ',provenance:'responses.summary_text'});await f.telegram.streamDrafts(at);
        assert.equal(calls[0].body.rich_message.html,'<tg-thinking>Sto elaborando…</tg-thinking>');
        ui.append(job.id,'reasoning_summary',{text:'Prima sintesi.\n<unsafe> **Dato**',provenance:'responses.summary_text'});await f.telegram.streamDrafts(new Date(Date.parse(at)+21000).toISOString());
        assert.equal(calls[1].body.rich_message.html,'<tg-thinking>Prima sintesi.<br>&lt;unsafe&gt; <b>Dato</b></tg-thinking>');assert.doesNotMatch(calls[1].body.rich_message.html,/private|<img/);
    }finally{f.close();}
});

for(const state of ['sent','uncertain'])test('historical unversioned '+state+' rich receipt is never reformatted or replayed',async()=>{
    let calls=0;const f=fixture(async(method,body)=>{calls++;return {message_id:16};});try{
        const answer='# Storico\n\n- Dato',job=f.complete(answer),event='answer:'+job.id;f.telegram.capture(at);const old={generation:'layout-owner',chatId:42,botGeneration:null,checksum:hash(answer),htmlBytes:Buffer.byteLength(telegramHtml(answer),'utf8')};f.store.set('telegramRichFinal:'+event,old);f.store.run('UPDATE telegram_outbox SET status=?,attempts=1,message_id=? WHERE event_id=?',state,state==='sent'?16:null,event);
        const row=f.store.one('SELECT * FROM telegram_outbox WHERE event_id=?',event),bytes=f.store.one('SELECT value FROM meta WHERE key=?','telegramRichFinal:'+event).value;f.telegram.recover();f.telegram.capture(at);await f.telegram.deliver(at);assert.equal(calls,0);assert.deepEqual(f.store.one('SELECT * FROM telegram_outbox WHERE event_id=?',event),row);assert.equal(f.store.one('SELECT value FROM meta WHERE key=?','telegramRichFinal:'+event).value,bytes);
    }finally{f.close();}
});

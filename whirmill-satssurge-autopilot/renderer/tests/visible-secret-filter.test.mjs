// Synthetic shapes only. Assertion messages/logs never include candidate values or HTML.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inertDocument } from '../policy.mjs';
const fake = ['123456789', ':', 'abcdefghijklmnopqrstuvwx'];
const cases = {
 plain: `<p>${fake.join('')}</p>`,
 inline: `<p><span>${fake[0]}:</span><span>${fake[2]}</span></p>`,
 nested: `<p><span>${fake[0]}</span><strong>:</strong><em>${fake[2].slice(0, 12)}</em><span>${fake[2].slice(12)}</span></p>`,
 entity: `<p><span>${fake[0]}&#58;</span><span>${fake[2]}</span></p>`,
 entityAcrossNodes: `<p><span>${fake[0]}&#x3a;${fake[2].slice(0, 4)}</span><span>&#101;${fake[2].slice(5)}</span></p>`,
};
for (const [name, html] of Object.entries(cases)) test(`recognized synthetic shape rejected after DOM decoding: ${name}`, () => {
 let outcome = 'accepted';
 try { inertDocument(html); } catch (error) { outcome = error.message === 'sensitive content' ? 'sensitive' : 'other rejection'; }
 assert.equal(outcome, 'sensitive', 'Expected sensitive-content rejection at the DOM policy boundary');
});
test('other existing recognized prefixes remain rejected across inline boundaries', () => {
 for (const [prefix, tail] of [['sk-', 'abcdefghijklmnop'], ['nsec1', 'abcdefghijklmnopqrstuvwxyz'], ['lnbc', 'abcdefghijklmnopqrstuvwxyz'], ['ghp_', 'abcdefghijklmnop']]) {
  let outcome='accepted';
  try { inertDocument(`<p><span>${prefix}</span><span>${tail}</span></p>`); } catch(error) { outcome=error.message; }
  assert.equal(outcome, 'sensitive content', 'Existing recognized family must survive inline boundaries');
 }
});
test('benign inline text and entities preserve visible source provenance', () => {
 const provenance={observedAt:'2026-10-12T18:00:00Z',coverage:'Partial source',evidenceRefs:['source-1']};
 const html='<main><h1>Re<span>port</span></h1><p>à è &#8364; · 123456789: ordinary reference</p><p><span>2026-10-12T18:</span><strong>00:00Z</strong> · Partial <em>source</em> · source-1</p></main>';
 assert.doesNotThrow(()=>inertDocument(html,provenance),'Benign decoded inline content with exact provenance is accepted');
});
test('head-only or missing provenance continues to fail', () => {
 const provenance={observedAt:'2026-10-12T18:00:00Z',coverage:'Partial source',evidenceRefs:['source-1']};
 const html='<html><head><title>2026-10-12T18:00:00Z Partial source source-1</title></head><body><p>Report</p></body></html>';
 let outcome='accepted'; try { inertDocument(html,provenance); } catch(error) { outcome=error.message; }
 assert.equal(outcome,'missing visible provenance','Metadata still cannot replace body provenance');
});

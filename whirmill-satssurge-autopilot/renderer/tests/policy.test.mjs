import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inertDocument,validateStyle } from '../policy.mjs';
test('DLS optional long report stays semantic and agents may compose different layouts',async()=>{
 const long=await readFile(new URL('../../content/dls/v1/example.html',import.meta.url),'utf8');assert.match(inertDocument(long),/Giorno 3/);assert.match(inertDocument('<main><h1>Nuovo layout</h1><section class="grid"><p>à è €</p><p>Copertura parziale</p></section></main>'),/Nuovo layout/);
});
test('active HTML, network/file resources and malformed/hidden data fail closed without rewriting',()=>{
 for(const body of ['<script>alert(1)</script>','<p onclick="x()">value</p>','<img src="https://example.invalid">','<iframe src="file:///credentials">','<meta http-equiv="refresh" content="0;url=http://example.invalid">','<base href="file:///">','<style>p{opacity:0}</style>','<p class="arbitrary">value</p>','<p style="transform:scale(0)">value</p>','<p style="line-height:0">value</p>','<p style="color:#ffffff">value</p>','<p style="opacity:0">value</p>','<p style="background:url(data:text/html,x)">value</p>','<p>lnbc123456789abcdefghijklmnop</p>','<template>hidden</template>','<svg width="660" height="180" viewBox="0 0 660 180"><foreignObject>bad</foreignObject></svg>','<p title="raw">value</p>'])assert.throws(()=>inertDocument(body),body);
});
test('safe DLS styles enforce readable contrast vocabulary, finite sizes and no cascade escape',()=>{
 validateStyle('font-size:8pt;line-height:1.5;color:#111113;background-color:#ffffff');
 for(const value of ['font-size:0pt','font-size:49pt','color:transparent','font-size:8pt!important','--x:1','color:var(--x)','font-weight:100','color:#111113;color:#52525b','line-height:0','margin:-9999pt'])assert.throws(()=>validateStyle(value),value);
});
test('SVG viewport, fonts, geometry and namespace are bounded before browser admission',()=>{
 const wrap=inner=>`<main><p>Chart</p><svg width="660" height="180" viewBox="0 0 660 180">${inner}</svg></main>`;
 assert.match(inertDocument(wrap('<rect x="10" y="10" width="20" height="20" fill="#1d4ed8"/><text x="50" y="50" font-size="12">Volume 20 sat</text>')),/Volume/);
 for(const x of ['<text x="0" y="0" font-size="0">Invisible</text>','<rect x="-1" y="0" width="20" height="20"/>','<text x="0" y="12" font-size="12" fill="none">Invisible</text>','<path d="M0 0"/>','<text x="0" y="12" font-size="12" transform="scale(0)">Invisible</text>','<svg width="80" height="40" viewBox="0 0 80 40"></svg>'])assert.throws(()=>inertDocument(wrap(x)),x);
});
test('visible source timestamp, coverage and evidence cannot be dropped from an otherwise valid report',()=>{
 const provenance={observedAt:'2026-10-12T18:00:00Z',coverage:'Partial source',evidenceRefs:['source-1']};
 const html='<main><h1>Report</h1><p>2026-10-12T18:00:00Z · Partial source · source-1</p></main>';
 assert.match(inertDocument(html,provenance),/source-1/);
 for(const field of ['2026-10-12T18:00:00Z','Partial source','source-1'])assert.throws(()=>inertDocument(html.replace(field,''),provenance),/provenance/);
});

test('head titles cannot substitute for visible snapshot provenance',()=>{
 const provenance={observedAt:'2026-10-12T18:00:00Z',coverage:'Partial source',evidenceRefs:['source-1']};
 assert.throws(()=>inertDocument('<!doctype html><html><head><title>2026-10-12T18:00:00Z Partial source source-1</title></head><body><p>Report</p></body></html>',provenance),/provenance/);
});

test('private token in document title or encoded SVG metadata is rejected even outside visible provenance',()=>{
 for(const html of ['<html><head><title>123456789:abcdefghijklmnopqrstuvwxyz</title></head><body><p>Report</p></body></html>', '<main><p>Report</p><svg width="100" height="100" viewBox="0 0 100 100" role="img" aria-label="123456789&#58;abcdefghijklmnopqrstuvwxyz"></svg></main>'])assert.throws(()=>inertDocument(html),/sensitive/);
});

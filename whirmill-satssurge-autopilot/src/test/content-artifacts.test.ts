import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, symlink, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactRoute, checksum, csvCell, escapeHtml, reportTable, submitRender, readRenderedArtifact, DLS_CSS_SHA256, DLS_FONT_SHA256, type RenderRequest } from '../content-artifacts.js';
const input='<html><body><p>Dati di esempio</p></body></html>';
const request=(artifactId='report-1'):RenderRequest=>({protocol:1,requestId:'owner-request-1',artifactId,format:'pdf',inputSha256:checksum(input),dlsVersion:'1.0.0',evidenceRefs:['fixture-1'],observedAt:'2026-10-10T12:30:00Z',coverage:'Dati di esempio',revisionOf:null});
test('partial IPC resumes original input and matching staged identity with serialized retries and no rewrite',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'artifacts-partial-')));try{
  const job=join(root,'report-1');await mkdir(job);await writeFile(join(job,'input.html'),input);const before=await stat(join(job,'input.html'));
  await writeFile(join(job,'.request-11111111-1111-4111-8111-111111111111'),JSON.stringify(request()));
  assert.deepEqual(await Promise.all([submitRender(root,request(),input),submitRender(root,request(),input)]),['submitted','existing']);
  const after=await stat(join(job,'input.html'));assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(await readFile(join(job,'input.html'),'utf8'),input);assert.deepEqual(JSON.parse(await readFile(join(job,'request.json'),'utf8')),request());assert.equal((await readdir(job)).filter(name=>name.startsWith('artifact.')).length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('partial IPC rejects missing, changed or symlink input, inconsistent existing request and mismatched staging',async()=>{
 for(const scenario of ['missing-input','changed-input','symlink-input','symlink-request','existing-request-missing-input','wrong-staged-request','wrong-staged-revision','wrong-staged-job','ambiguous-output']){
  const root=await realpath(await mkdtemp(join(tmpdir(),'artifacts-invalid-partial-')));try{
   const job=join(root,'report-1');await mkdir(job);
   if(scenario==='symlink-input'){await writeFile(join(root,'original.html'),input);await symlink(join(root,'original.html'),join(job,'input.html'));}
   else if(!scenario.includes('missing-input'))await writeFile(join(job,'input.html'),scenario==='changed-input'?'different':input);
   if(scenario==='existing-request-missing-input')await writeFile(join(job,'request.json'),JSON.stringify(request()));
   if(scenario==='symlink-request'){await writeFile(join(root,'original-request.json'),JSON.stringify(request()));await symlink(join(root,'original-request.json'),join(job,'request.json'));}
   if(scenario.startsWith('wrong-staged'))await writeFile(join(job,'.request-11111111-1111-4111-8111-111111111111'),JSON.stringify({...request(),...(scenario==='wrong-staged-request'?{requestId:'another-owner'}:scenario==='wrong-staged-revision'?{revisionOf:'previous-revision'}:{artifactId:'another-job'})}));
   if(scenario==='ambiguous-output')await writeFile(join(job,'artifact.pdf'),'%PDF-uncertain');
   const before=await readdir(job);await assert.rejects(submitRender(root,request(),input),scenario);assert.deepEqual(await readdir(job),before);
  }finally{await rm(root,{recursive:true,force:true});}
 }
});
test('content helpers escape source text and ready exports bypass renderer',()=>{
 assert.equal(escapeHtml('<script>"&'), '&lt;script&gt;&quot;&amp;');
 assert.match(reportTable(['Nome'],[['<img src=x>']]), /&lt;img src=x&gt;/);
 assert.throws(()=>reportTable(['Nome'],[['x','y']]));
 for(const format of ['csv','xlsx','txt','docx'])assert.equal(artifactRoute(format),'ready-file');
 assert.equal(artifactRoute('pdf'),'renderer');assert.equal(artifactRoute('png'),'renderer');
 assert.equal(csvCell(' \t=HYPERLINK("x")'),'"\' \t=HYPERLINK(""x"")"');
});
test('filesystem IPC preserves identities, rejects mutation/traversal/symlink and verifies exact receipt bytes',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'artifacts-')));
 try{
  assert.equal(await submitRender(root,request(),input),'submitted');
  assert.equal(await submitRender(root,request(),input),'existing');
  await assert.rejects(submitRender(root,{...request(),coverage:'Changed'},input),/conflict/);
  await assert.rejects(submitRender(root,request('../escape'),input));
  await assert.rejects(submitRender(root,{...request(),requestId:null} as unknown as RenderRequest,input));
  await assert.rejects(submitRender(root,{...request(),observedAt:'2026-02-31T12:30:00Z'},input));
  const reordered=Object.fromEntries(Object.entries(request()).reverse()) as unknown as RenderRequest;
  assert.equal(await submitRender(root,reordered,input),'existing');
  await symlink(root,join(root,'evil'));await assert.rejects(submitRender(root,request('evil'),input));await rm(join(root,'evil'));
  const data=Buffer.from('%PDF-fixture');const manifest={protocol:1,rendererVersion:'1.0.0',request:request(),requestSha256:checksum(JSON.stringify(request())+'\n'),artifactSha256:checksum(data),bytes:data.length,mime:'application/pdf',filename:'artifact.pdf',proof:{layout:{version:'puppeteer-visible-v1',textBoxes:2,svgBoxes:0,minFontPt:8},pages:1,selectedPage:null,width:null,height:null,versions:{puppeteer:'25.12.0',chromium:'HeadlessChrome/154.0.8037.92'},fontSha256:[...DLS_FONT_SHA256],dlsSha256:DLS_CSS_SHA256,inputSha256:checksum(input),requestSha256:checksum(JSON.stringify(request())+'\n')}};
  await writeFile(join(root,'report-1','artifact.pdf'),data);await writeFile(join(root,'report-1','manifest.json'),JSON.stringify(manifest));
  assert.deepEqual((await readRenderedArtifact(root,'report-1')).data,data);
  for(const changed of [{...manifest.proof,layout:undefined},{...manifest.proof,layout:{...manifest.proof.layout,version:'legacy'}},{...manifest.proof,layout:{...manifest.proof.layout,minFontPt:0}},{...manifest.proof,layout:{...manifest.proof.layout,textBoxes:0}},{...manifest.proof,dlsSha256:checksum('other-css')},{...manifest.proof,fontSha256:[checksum('other-font1'),checksum('other-font2')]},{...manifest.proof,fontSha256:[DLS_FONT_SHA256[0],DLS_FONT_SHA256[0]]},{...manifest.proof,inputSha256:checksum('different-input')}]){
    await writeFile(join(root,'report-1','manifest.json'),JSON.stringify({...manifest,proof:changed}));
    await assert.rejects(readRenderedArtifact(root,'report-1'),/Unqualified/);
  }
  await writeFile(join(root,'report-1','manifest.json'),JSON.stringify(manifest));
  await writeFile(join(root,'report-1','artifact.pdf'),'%PDF-tampered');await assert.rejects(readRenderedArtifact(root,'report-1'),/checksum/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('pending capacity is bounded and input hash/extra metadata fail closed',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'artifacts-capacity-')));
 try{
  await assert.rejects(submitRender(root,request(),input+'extra'),/checksum/);
  await assert.rejects(submitRender(root,{...request(),other:'private'} as RenderRequest,input));
  const admissions=await Promise.allSettled(Array.from({length:9},(_,n)=>submitRender(root,request('job-'+n),input)));
  assert.equal(admissions.filter(result=>result.status==='fulfilled').length,6);
  assert.equal(admissions.filter(result=>result.status==='rejected').length,3);
  await assert.rejects(submitRender(root,request('overflow'),input),/capacity/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('FIFO request, input, receipt and artifact reject in watchdog-bounded actual Node processes',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'artifacts-fifo-')));
 try{
  await submitRender(root,request(),input);const job=join(root,'report-1');const data=Buffer.from('%PDF-fixture');
  const rawRequest=JSON.stringify(request())+'\n';
  const manifest={protocol:1,rendererVersion:'1.0.0',request:request(),requestSha256:checksum(rawRequest),artifactSha256:checksum(data),bytes:data.length,mime:'application/pdf',filename:'artifact.pdf',proof:{layout:{version:'puppeteer-visible-v1',textBoxes:2,svgBoxes:0,minFontPt:8},pages:1,selectedPage:null,width:null,height:null,versions:{puppeteer:'25.12.0',chromium:'HeadlessChrome/154.0.8037.92'},fontSha256:[...DLS_FONT_SHA256],dlsSha256:DLS_CSS_SHA256,inputSha256:checksum(input),requestSha256:checksum(rawRequest)}};
  const files:Record<string,string|Buffer>={'request.json':rawRequest,'input.html':input,'manifest.json':JSON.stringify(manifest),'artifact.pdf':data};
  await writeFile(join(job,'manifest.json'),files['manifest.json']!);await writeFile(join(job,'artifact.pdf'),data);
  for(const filename of Object.keys(files)){
   await rm(join(job,filename));execFileSync('mkfifo',[join(job,filename)]);
   const moduleUrl=new URL('../content-artifacts.js',import.meta.url).href;
   const script=`import {readRenderedArtifact} from ${JSON.stringify(moduleUrl)};try{await readRenderedArtifact(${JSON.stringify(root)},'report-1');process.exitCode=2;}catch{process.stdout.write('rejected');}`;
   assert.equal(execFileSync(process.execPath,['--input-type=module','-e',script],{timeout:2000,encoding:'utf8'}),'rejected');
   await rm(join(job,filename));await writeFile(join(job,filename),files[filename]!);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

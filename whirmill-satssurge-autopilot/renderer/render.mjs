import puppeteer from 'puppeteer-core';
import { PDFDocument } from 'pdf-lib';
import { readFile,open,mkdtemp,rm,link,unlink,lstat,realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readRenderRequest,checksum,CONTENT_LIMITS,DLS_VERSION,DLS_CSS_SHA256,DLS_FONT_SHA256 } from './dist/content-artifacts.js';
import { inertDocument,visibleLayout } from './policy.mjs';
const exec=promisify(execFile),root='/content-jobs',id=process.argv[2];
async function closed(path,max){const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await f.stat();if(!s.isFile()||s.nlink!==1||s.size>max)throw Error('file');const data=Buffer.alloc(s.size+1),r=await f.read(data,0,data.length,0);if(r.bytesRead!==s.size)throw Error('size');return data.subarray(0,s.size);}finally{await f.close();}}
async function publish(path,data){const staging=path+'.stage-'+randomUUID();const f=await open(staging,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await f.writeFile(data);await f.sync();}finally{await f.close();}try{await link(staging,path);}finally{await unlink(staging);}const dir=await open(join(root,id),constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}}
let browser,scratch;
try{
 const request=await readRenderRequest(root,id),job=join(root,id),rawRequest=await closed(join(job,'request.json'),16384),input=await closed(join(job,'input.html'),CONTENT_LIMITS.inputBytes);
 if(checksum(input)!==request.inputSha256)throw Error('input');
 const html=inertDocument(input.toString('utf8'),request);
 const css=await readFile('/app/content/dls/v1/style.css','utf8');if(checksum(css)!==DLS_CSS_SHA256)throw Error('css');
 const fonts=[];for(const name of ['Manrope-700.ttf','DMSans-400.ttf','DMSans-700.ttf'])fonts.push(await readFile('/app/content/dls/v1/fonts/'+name));
 if(fonts.some((f,i)=>checksum(f)!==DLS_FONT_SHA256[i]))throw Error('fonts');
 scratch=await mkdtemp('/tmp/render-');
 browser=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:true,pipe:true,userDataDir:join(scratch,'profile'),env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',HOME:scratch,TMPDIR:scratch,XDG_CONFIG_HOME:join(scratch,'config'),XDG_CACHE_HOME:join(scratch,'cache')},timeout:10000,protocolTimeout:10000,args:['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-background-networking','--disable-extensions','--no-first-run','--disable-sync','--no-default-browser-check','--host-resolver-rules=MAP * ~NOTFOUND']});
 const version=await browser.version();if(!/\/154\.0\.8037\.92$/.test(version))throw Error('browser version');
 const page=await browser.newPage();page.setDefaultTimeout(10000);await page.setViewport({width:673,height:1123,deviceScaleFactor:1});await page.setJavaScriptEnabled(false);await page.setBypassServiceWorker(true);await page.setCacheEnabled(false);await page.setRequestInterception(true);
 const fontUrls=new Map(fonts.map((f,i)=>['data:font/ttf;base64,'+f.toString('base64'),i]));let denied=false;
 page.on('request',r=>{if(fontUrls.has(r.url())&&r.resourceType()==='font')void r.continue().catch(()=>{});else{denied=true;void r.abort().catch(()=>{});}});
 const fontCss=`@font-face{font-family:Manrope;src:url("${[...fontUrls.keys()][0]}");font-weight:700;}@font-face{font-family:"DM Sans";src:url("${[...fontUrls.keys()][1]}");font-weight:400;}@font-face{font-family:"DM Sans";src:url("${[...fontUrls.keys()][2]}");font-weight:700;}`;
 const csp="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
 const document=html.replace('<head>',`<head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${fontCss}\n${css}\nmain,p,li,h1,h2,h3,h4{overflow-wrap:anywhere}svg text{font-family:"DM Sans";font-weight:400;fill:#111113}pre{white-space:pre-wrap}</style>`);
 await page.emulateMediaType('print');await page.setContent(document,{waitUntil:'load',timeout:10000});
 await page.evaluate(async()=>{await document.fonts.ready;if(!document.fonts.check('10pt "DM Sans"')||!document.fonts.check('10pt Manrope'))throw Error('fonts');});
 const layout=await page.evaluate(visibleLayout);if(denied)throw Error('network');
 const pdf=Buffer.from(await page.pdf({format:'A4',preferCSSPageSize:true,printBackground:true,timeout:10000,waitForFonts:true}));if(pdf.length>CONTENT_LIMITS.outputBytes)throw Error('output size');
 const count=(await PDFDocument.load(pdf,{updateMetadata:false})).getPageCount();if(count<1||count>CONTENT_LIMITS.pages)throw Error('pages');
 const pdfFile=join(scratch,'report.pdf');const pf=await open(pdfFile,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);try{await pf.writeFile(pdf);}finally{await pf.close();}
 const embedded=await exec('/usr/bin/pdffonts',[pdfFile],{timeout:5000,maxBuffer:16384});
 const fontRows=embedded.stdout.trim().split('\n').slice(2);if(!fontRows.length||fontRows.some(row=>!/(?:Manrope|DMSans)/.test(row)||!/CID TrueType/.test(row)||!/yes\s+yes\s+yes/.test(row)))throw Error('PDF font embedding');
 let data=pdf;
 if(request.format==='png'){
  await exec('/usr/bin/pdftoppm',['-f','1','-l','1','-singlefile','-scale-to-x','993','-scale-to-y','1404','-png',join(scratch,'report.pdf'),join(scratch,'preview')],{timeout:10000,maxBuffer:1024});data=await closed(join(scratch,'preview.png'),CONTENT_LIMITS.outputBytes);
  if(data.readUInt32BE(16)!==993||data.readUInt32BE(20)!==1404)throw Error('png profile');
 }
 const manifest={protocol:1,rendererVersion:DLS_VERSION,request,requestSha256:checksum(rawRequest),artifactSha256:checksum(data),bytes:data.length,mime:request.format==='pdf'?'application/pdf':'image/png',filename:'artifact.'+request.format,proof:{layout,pages:count,selectedPage:request.format==='png'?1:null,width:request.format==='png'?993:null,height:request.format==='png'?1404:null,versions:{puppeteer:'25.12.0',chromium:version,node:process.versions.node},fontSha256:fonts.map(checksum),dlsSha256:checksum(css),inputSha256:checksum(input),requestSha256:checksum(rawRequest)}};
 // Worker cancellation is checked by the supervisor through publication; app
 // also fences the immutable receipt before delivery. No replacement of evidence.
 try{await lstat(join(job,'cancel.json'));throw Error('cancelled');}catch(e){if(e.code!=='ENOENT')throw e;}
 await publish(join(job,manifest.filename),data);await publish(join(job,'manifest.json'),JSON.stringify(manifest)+'\n');
}catch{process.exitCode=1;}
finally{if(browser){const p=browser.process();const timer=setTimeout(()=>p?.kill('SIGKILL'),1000);try{await browser.close();}catch{}finally{clearTimeout(timer);}}if(scratch)await rm(scratch,{recursive:true,force:true});}

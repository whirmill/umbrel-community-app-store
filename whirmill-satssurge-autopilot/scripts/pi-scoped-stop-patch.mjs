import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const directory=dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(readFileSync(resolve(directory,'pi-scoped-stop-patch.json'),'utf8'));
const pkg=resolve(directory,'../node_modules/@earendil-works/pi-durable');
const sha=s=>createHash('sha256').update(s).digest('hex');
if(JSON.parse(readFileSync(resolve(pkg,'package.json'),'utf8')).version!==manifest.version)throw Error('Unsupported Pi Durable version');
for(const guard of manifest.guards)if(sha(readFileSync(resolve(pkg,guard.file),'utf8'))!==guard.sha256)throw Error('Unsupported native Pi contract: '+guard.file);
// Validate every input/output before writing any file; npm lock integrity stays upstream.
const writes=manifest.files.map(entry=>{
 const path=resolve(pkg,entry.file),source=readFileSync(path,'utf8');
 if(sha(source)===entry.patched)return null;
 if(sha(source)!==entry.original)throw Error('Unsupported Pi Durable input: '+entry.file);
 let output=source;
 for(const [before,after] of entry.changes){if(output.split(before).length!==2)throw Error('Ambiguous patch anchor');output=output.replace(before,after);}
 if(sha(output)!==entry.patched)throw Error('Pi Durable patch output digest mismatch');
 return {path,output};
});
for(const write of writes)if(write)writeFileSync(write.path,write.output);
console.log(manifest.patch+': verified');

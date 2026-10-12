import { mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
/** Deployment-owned exclusive IPC directory; no chmod/chown of an existing mount.
 * Both containers use app UID/GID 1000. The renderer sees only this directory. */
export function prepareContentDirectory(directory:string):void {
 const path=resolve(directory);if(path!==directory)throw Error('Absolute content directory required');
 mkdirSync(path,{recursive:true,mode:0o700});const info=lstatSync(path);
 if(info.isSymbolicLink()||!info.isDirectory()||realpathSync(path)!==path||(info.mode&0o777)!==0o700||typeof process.getuid!=='function'||info.uid!==process.getuid())throw Error('Exclusive app-owned content directory required');
}

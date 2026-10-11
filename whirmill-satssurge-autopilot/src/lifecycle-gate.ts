import {fstatSync, readFileSync, statSync} from 'node:fs';
import {resolve, join} from 'node:path';
/** Linux inherited open-file descriptions keep the fence alive after launcher death. */
export function requireLifecycleGate(phase: 'runtime' | 'migration') {
  if(process.getuid?.() !== 1000 || process.env.SATSSURGE_GATE_PHASE !== phase)
    throw new Error('Mandatory lifecycle launcher required');
  const directory=resolve(process.env.DATA_DIR ?? '/data');
  for(const [variable,name,mode] of [
    ['SATSSURGE_GATE_FD','maintenance.lock',phase==='runtime'?'READ':'WRITE'],
    ['SATSSURGE_EXECUTOR_FD','executor.lock','WRITE'],
  ] as const){
    const value=process.env[variable];
    if(!value || !/^\d+$/.test(value))throw new Error('Lifecycle descriptor missing');
    const fd=Number(value), inherited=fstatSync(fd), current=statSync(join(directory,name));
    if(!inherited.isFile() || inherited.ino!==current.ino || inherited.dev!==current.dev)
      throw new Error('Lifecycle lock inode changed');
    const info=readFileSync(`/proc/self/fdinfo/${fd}`,'utf8');
    if(!new RegExp(`lock:.*FLOCK\\s+ADVISORY\\s+${mode}\\s`).test(info))
      throw new Error('Lifecycle fence mode is not qualified');
  }
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {migrateStorage} from '../lifecycle-storage.js';

// The launcher skips its database checkpoint when installed versions already equal these targets,
// so a schema change that forgets to update the file must fail here.
test('launcher schema targets match the versions produced by storage migration',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'satssurge-schema-targets-'));
 try{
  await migrateStorage(directory);
  const actual:Record<string,{userVersion:number;durableVersion:number|null}>={};
  for(const name of ['operational.sqlite','durable.sqlite','oauth.sqlite']){
   const db=new DatabaseSync(join(directory,name),{readOnly:true});
   try{
    const durable=db.prepare("SELECT 1 FROM sqlite_schema WHERE name='durable_schema'").get()?db.prepare('SELECT version FROM durable_schema WHERE singleton=1').get() as any:undefined;
    actual[name]={userVersion:Number((db.prepare('PRAGMA user_version').get() as any).user_version),durableVersion:durable?Number(durable.version):null};
   }finally{db.close();}
  }
  const targets=JSON.parse(readFileSync(new URL('../../scripts/schema-targets.json',import.meta.url),'utf8'));
  assert.deepEqual(actual,targets);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

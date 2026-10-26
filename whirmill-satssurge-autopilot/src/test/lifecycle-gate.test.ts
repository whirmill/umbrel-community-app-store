import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readdirSync,rmSync,mkdirSync,writeFileSync,existsSync,statSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,delimiter} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {migrateStorage} from '../lifecycle-storage.js';

test('public server and migration entry points reject before any database or owner initialization',()=>{
  for(const entry of ['server.js','lifecycle-migrate.js']){
    const directory=mkdtempSync(join(tmpdir(),'satssurge-gate-'));
    try{
      const result=spawnSync(process.execPath,[join('dist',entry)],{
        env:{...process.env,DATA_DIR:directory,SATSSURGE_GATE_PHASE:'',SATSSURGE_GATE_FD:''},
        encoding:'utf8',timeout:5000,
      });
      assert.notEqual(result.status,0);
      assert.match(result.stderr,/Mandatory lifecycle launcher required/);
      assert.deepEqual(readdirSync(directory),[]);
    }finally{rmSync(directory,{recursive:true,force:true});}
  }
});


test('actual three-storage migrations reopen preserving synthetic receipts, durable identities and OAuth',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'satssurge-storage-'));
  try{
    await migrateStorage(directory);
    const operational=new DatabaseSync(join(directory,'operational.sqlite'));
    operational.prepare("INSERT INTO meta VALUES(?,?)").run('fixtureReceipt','synthetic-original-operation-id');
    operational.close();
    const durable=new DatabaseSync(join(directory,'durable.sqlite'));
    // Native storage record identity, with no Harness or provider initialization.
    durable.prepare('INSERT INTO record_ids VALUES(?,?)').run(900,'submission');
    durable.prepare('INSERT INTO submissions VALUES(?,?,?,?,?)').run(900,901,'synthetic-original-request','done',JSON.stringify({id:900,requestId:'synthetic-original-request'}));
    durable.close();
    const oauth=new DatabaseSync(join(directory,'oauth.sqlite'));
    oauth.prepare('INSERT INTO credentials VALUES(?,?)').run('openai',JSON.stringify({type:'oauth',accessToken:'synthetic-fixture-only'}));
    oauth.close();
    await migrateStorage(directory);
    for(const [name,sql,expected] of [
      ['operational.sqlite',"SELECT value FROM meta WHERE key='fixtureReceipt'",'synthetic-original-operation-id'],
      ['durable.sqlite','SELECT request_id AS value FROM submissions WHERE id=900','synthetic-original-request'],
      ['oauth.sqlite',"SELECT content AS value FROM credentials WHERE provider='openai'",JSON.stringify({type:'oauth',accessToken:'synthetic-fixture-only'})],
    ]){
      const db=new DatabaseSync(join(directory,name!));
      try{assert.equal(db.prepare(sql!).get()?.value,expected);}finally{db.close();}
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});

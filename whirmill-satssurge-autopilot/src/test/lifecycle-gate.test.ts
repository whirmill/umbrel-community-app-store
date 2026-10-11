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
  for(const entry of ['server.js','lifecycle-migrate.js','import-cli.js']){
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

test('actual npm import with DATA_DIR unset uses normalized gate directory and its database inode',()=>{
  const fixture=mkdtempSync(join(tmpdir(),'satssurge-import-default-'));
  const data=join(fixture,'gate-data'), history=join(fixture,'history'), commands=join(fixture,'commands');
  mkdirSync(data);mkdirSync(history);mkdirSync(commands);
  const preload=join(fixture,'fixture-linux-gate.mjs');
  // Only UID/Linux fdinfo are fixture substitutions on macOS. File descriptors,
  // inode checks, launcher, storage migrations, npm and importer remain actual.
  writeFileSync(preload,`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
process.getuid=()=>1000; const read=fs.readFileSync;
fs.readFileSync=function(path,...args){if(String(path).startsWith('/proc/self/fdinfo/')){
 const fd=String(path).split('/').at(-1), exclusive=fd===process.env.SATSSURGE_EXECUTOR_FD||process.env.SATSSURGE_GATE_PHASE==='migration';
 return 'lock: 1: FLOCK ADVISORY '+(exclusive?'WRITE':'READ')+' 1000 0:0:0 0 EOF\\n';}return read.call(this,path,...args)};
syncBuiltinESMExports();`);
  const python=spawnSync('python3',['-c','import sys; print(sys.executable)'],{encoding:'utf8'}).stdout.trim();
  const launcher=join(commands,'python3');
  writeFileSync(launcher,`#!${python}
import pathlib,os,sys
sys.path.insert(0,str(pathlib.Path('scripts').resolve()))
import app_launcher
app_launcher.os.getuid=lambda:1000
original=pathlib.Path.resolve
def resolve(self,*args,**kwargs):
    return pathlib.Path(os.environ['FIXTURE_DEFAULT_DATA']) if str(self)=='/data' else original(self,*args,**kwargs)
pathlib.Path.resolve=resolve
sys.argv=sys.argv[1:]
sys.exit(app_launcher.main())
`,{mode:0o700});
  const env={...process.env,FIXTURE_DEFAULT_DATA:data,
    PATH:commands+delimiter+dirname(process.execPath)+delimiter+process.env.PATH,
    NODE_OPTIONS:'--import='+pathToFileURL(preload).href,
  };
  delete (env as NodeJS.ProcessEnv).DATA_DIR;
  try{
    const before=existsSync(join(process.cwd(),'data'));
    const result=spawnSync('npm',['run','import','--',history],{env,encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,String(result.error??'')+result.stderr+result.stdout);
    assert.equal(existsSync(join(process.cwd(),'data')),before);
    const database=join(data,'operational.sqlite'), inode=statSync(database).ino;
    const db=new DatabaseSync(database);
    try{assert.ok(db.prepare("SELECT value FROM meta WHERE key='importReport'").get());}finally{db.close();}
    assert.equal(statSync(database).ino,inode);
    assert.equal(JSON.parse(readFileSync(join(data,'lifecycle.json'),'utf8')).phase,'ready');
    assert.ok(existsSync(join(data,'executor.lock')));
    assert.ok(existsSync(join(data,'maintenance.lock')));
  }finally{rmSync(fixture,{recursive:true,force:true});}
});

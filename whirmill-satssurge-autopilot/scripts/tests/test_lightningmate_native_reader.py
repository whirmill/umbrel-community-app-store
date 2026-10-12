import hashlib,io,json,os,pathlib,signal,subprocess,sys,tarfile,tempfile,time,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parents[1]));import lightningmate_native_reader as r
P=pathlib.Path(__file__).parents[1]

def archive(body=b'public fixture',name='auth.js',kind=tarfile.REGTYPE):
    stream=io.BytesIO()
    with tarfile.open(fileobj=stream,mode='w',format=tarfile.USTAR_FORMAT) as t:
        info=tarfile.TarInfo(name);info.size=len(body) if kind==tarfile.REGTYPE else 0;info.type=kind
        if kind==tarfile.SYMTYPE:info.linkname='secret'
        t.addfile(info,io.BytesIO(body) if info.size else None)
    return stream.getvalue()
def state(pid):
    q=subprocess.run(['/bin/ps','-o','stat=','-p',str(pid)],capture_output=True,text=True)
    return q.stdout.strip()
class ArchiveTests(unittest.TestCase):
    def test_regular_public_file(self):
        self.assertEqual(r.public_source_digest(archive(),'/app/server/dist/services/auth.js'),hashlib.sha256(b'public fixture').hexdigest())
    def test_invalid_archive_rejected(self):
        good=archive()
        invalid=[archive(name='../auth.js'),archive(kind=tarfile.SYMTYPE),archive(body=b''),archive(body=b'x'*262145),good[:1024],good+b'X'*512,good[:1024]+b'X'+good[1025:]]
        # PAX extension and a second file must never be hidden by a tar parser.
        out=io.BytesIO()
        with tarfile.open(fileobj=out,mode='w',format=tarfile.PAX_FORMAT) as t:
            info=tarfile.TarInfo('auth.js');info.size=1;info.pax_headers={'comment':'extension'};t.addfile(info,io.BytesIO(b'x'))
        invalid.append(out.getvalue())
        out=io.BytesIO()
        with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as t:
            for name in ['auth.js','extra']:
                info=tarfile.TarInfo(name);info.size=1;t.addfile(info,io.BytesIO(b'x'))
        invalid.append(out.getvalue())
        for value in invalid:
            with self.subTest(length=len(value)):
                with self.assertRaises(r.Refusal):r.public_source_digest(value,'/app/server/dist/services/auth.js')
    def test_binding_only_inspect_and_four_fixed_public_archives(self):
        fixture={path:b'public '+path.encode() for path in r.SOURCES}
        pins={path:hashlib.sha256(body).hexdigest() for path,body in fixture.items()}
        meta={'id':r.CONTAINER,'image':r.IMAGE,'imageId':r.IMAGE_ID,'running':True,'restarting':False,'network':r.NETWORK,'ip':r.HOST,'version':['v0.7.7','END'],'startedAt':'2026-10-08T18:01:14.621745885Z','restartCount':0}
        calls=[]
        def command(args,cap=16384):
            calls.append((args,cap))
            if args[0]=='inspect':return json.dumps(meta).encode()
            self.assertEqual(args[0],'cp');self.assertEqual(args[2],'-');self.assertEqual(cap,1048576)
            path=args[1].split(':',1)[1];self.assertIn(path,fixture)
            return archive(fixture[path],path.rsplit('/',1)[1])
        config={'version':'0.7.7','nativeSourceHashes':dict(r.SOURCES),'runtimeBinding':{'containerId':'1'*64,'imageRef':r.IMAGE,'imageId':'sha256:'+'2'*64},'endpoint':{'ip':'127.0.0.1','port':3001,'networkId':'3'*64},'runtimeGeneration':{'startedAt':meta['startedAt'],'restartCount':0},'expectedLndNodeId':'02'+'4'*64,'dockerSha256':'5'*64};r.configure(config)
        meta.update(id=r.CONTAINER,imageId=r.IMAGE_ID,network=r.NETWORK,ip=r.HOST)
        native=r.Docker(r.Budget())
        with patch.object(r,'SOURCES',pins),patch.object(native,'verify_binary'),patch.object(native,'command',side_effect=command):
            native.binding();self.assertEqual(len(calls),5)
            meta['restartCount']=1
            with self.assertRaisesRegex(r.Refusal,'runtime_generation'):native.binding()
            meta['restartCount']=0;fixture[next(iter(fixture))]=b'changed'
            with self.assertRaisesRegex(r.Refusal,'source_binding'):native.binding()

class OwnershipTests(unittest.TestCase):
    def run_case(self,mode):
        with tempfile.TemporaryDirectory(dir=P,prefix='fixture-') as d:
            receipt=pathlib.Path(d)/'pids.json';done=pathlib.Path(d)/'done.json'
            command="import subprocess,sys,os,json,time; p=subprocess.Popen([sys.executable,'-I','-S','-c','import time;time.sleep(30)']);open(sys.argv[1],'w').write(json.dumps({'child':os.getpid(),'grandchild':p.pid,'pgid':os.getpgrp()}));time.sleep(30)"
            script='''import sys,json,os,subprocess,time
sys.path.insert(0,sys.argv[1]);import lightningmate_native_reader as r
real=r.subprocess.Popen
command=sys.argv[4]
def spawn(argv,**kw):
 assert kw['start_new_session'] is False
 return real([sys.executable,'-I','-S','-c',command,sys.argv[2]],**kw)
r.subprocess.Popen=spawn
native=r.Docker(r.Budget(seconds=.4 if sys.argv[5]=='timeout' else 10));native.verify_binary=lambda:None
try:native.command(['inspect'])
except r.Refusal as e:
 open(sys.argv[3],'w').write(json.dumps({'reason':e.code,'active':native.active is not None,'parent':os.getpid(),'pgid':os.getpgrp()}))
 time.sleep(30)
'''
            outer=subprocess.Popen([sys.executable,'-B','-I','-S','-c',script,str(P),str(receipt),str(done),command,mode],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,start_new_session=True)
            observed=None
            try:
                deadline=time.monotonic()+4
                while not receipt.exists() and time.monotonic()<deadline:time.sleep(.02)
                self.assertTrue(receipt.exists());observed=json.loads(receipt.read_text());self.assertEqual(observed['pgid'],outer.pid)
                if mode=='timeout':
                    while not done.exists() and time.monotonic()<deadline:time.sleep(.02)
                    self.assertTrue(done.exists());result=json.loads(done.read_text());self.assertEqual(result['reason'],'deadline');self.assertFalse(result['active']);self.assertEqual(result['pgid'],outer.pid)
                    self.assertEqual(state(observed['child']),'');self.assertIsNone(outer.poll())
                os.killpg(outer.pid,signal.SIGKILL);outer.wait(timeout=3)
                deadline=time.monotonic()+3
                while time.monotonic()<deadline and any(state(observed[k]) and not state(observed[k]).startswith('Z') for k in ['child','grandchild']):time.sleep(.05)
                states={k:state(observed[k]) for k in ['child','grandchild']}
                self.assertTrue(all(not v or v.startswith('Z') for v in states.values()),states)
                OWNERSHIP_RESULTS.append({'mode':mode,'outerPid':outer.pid,**observed,'statesAfterGroupKill':states,'outerReaped':True,'directChildReapedOnTimeout':mode=='timeout','liveOwnedProcesses':0})
            finally:
                if outer.poll() is None:os.killpg(outer.pid,signal.SIGKILL);outer.wait(timeout=3)
                outer.stderr.close()
    def test_timeout_reaps_direct_child_and_preserves_outer_group(self):self.run_case('timeout')
    def test_parent_sigkill_removes_inherited_group(self):self.run_case('sigkill')
OWNERSHIP_RESULTS=[]
if __name__=='__main__':
    program=unittest.main(exit=False)
    (P/'process-release.json').write_text(json.dumps(OWNERSHIP_RESULTS,indent=2,sort_keys=True))
    raise SystemExit(not program.result.wasSuccessful())

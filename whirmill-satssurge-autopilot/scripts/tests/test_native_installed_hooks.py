import contextlib
import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
import pathlib
import sys
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parents[1]))
import lightningmate_native_reader as r
import lightningmate_native_adapter as a
import lndg_native_reader as g
P=pathlib.Path(__file__).parents[1]
AT=dt.datetime(2026,10,12,tzinfo=dt.timezone.utc)

def config():
    return {'version':'0.7.7','readerSha256':a.READER_SHA,'hookSourceHash':'a'*64,'hostBootId':'b'*36,'generation':1,'nativeSourceHashes':dict(r.SOURCES),'runtimeBinding':{'containerId':'1'*64,'imageRef':r.IMAGE,'imageId':'sha256:'+'2'*64},'endpoint':{'ip':'127.0.0.1','port':3001,'networkId':'3'*64},'runtimeGeneration':{'startedAt':'2026-10-12T00:00:00Z','restartCount':0},'expectedLndNodeId':'02'+'4'*64,'dockerSha256':'5'*64}

def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),P/(name+'.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

class LMTests(unittest.TestCase):
    def test_current_config_replaces_historical_instance_and_closed_source_scope(self):
        c=config();r.configure(c);self.assertEqual(r.CONTAINER,c['runtimeBinding']['containerId']);self.assertEqual(r.NODE,c['expectedLndNodeId'])
        for mutate in [lambda c:c['endpoint'].update(port=3002),lambda c:c.update(version='0.7.8'),lambda c:c['nativeSourceHashes'].update({'/private/credential':'a'*64}),lambda c:c['runtimeBinding'].update(containerId='old'),lambda c:c.update(expectedLndNodeId='unknown')]:
            bad=config();mutate(bad)
            with self.assertRaises(r.Refusal):r.configure(bad)
    def test_actual_getters_and_new_normal_session_at_each_boundary(self):
        c=config();sessions=[];events=[];test=self
        class Docker:
            def __init__(self,budget):self.generation=None
            def binding(self):events.append('binding');test.assertEqual(self.generation,c['runtimeGeneration'])
            def password(self):events.append('password');return 'SYNTHETIC'
            def close(self):events.append('native_closed')
        class Http:
            def __init__(self,budget):self.stage=0;self.token=str(int(time.time()*1000)+60000)+'.'+chr(65+len(sessions))*43;sessions.append(self.token)
            def next(self,secret):
                n=self.stage;self.stage+=1;events.append(('read',n))
                if n==0:test.assertEqual(secret,'SYNTHETIC');return {'token':self.token}
                test.assertEqual(secret,self.token)
                if n==1:return {'authRequired':True,'unlocked':True}
                if n==2:return {'config':{field:False for field in r.FLAGS.values()}}
                if n==3:return {'lspModeEnabled':False}
                if n==4:return {'pubkey':c['expectedLndNodeId']}
                test.fail('extra request')
            def close(self):events.append('http_closed')
        with patch.object(r,'Docker',Docker),patch.object(r,'Http',Http):
            results=[a.acquire(r,c,reader_file_sha256=hashlib.sha256((P/'lightningmate_native_reader.py').read_bytes()).hexdigest(),wall=lambda:dt.datetime.now(dt.timezone.utc),monotonic=time.monotonic) for _ in range(2)]
        self.assertEqual(len(set(sessions)),2);self.assertEqual(events.count('password'),2);self.assertEqual(len([v for v in events if isinstance(v,tuple)]),10)
        self.assertEqual(results[0]['settingsDigest'],results[1]['settingsDigest']);self.assertEqual(set(results[0]),a.HOOK_KEYS)
        self.assertNotIn('SYNTHETIC',json.dumps(results));self.assertEqual(events.count('http_closed'),4);self.assertEqual(events.count('native_closed'),4)
    def test_missing_enabled_zero_string_or_wrong_identity_fails_projection(self):
        c=config();native={'contract':'satssurge-lm-native-read-v1','version':'0.7.7','sourceHashes':c['nativeSourceHashes'],'runtimeBinding':c['runtimeBinding'],'runtimeGeneration':c['runtimeGeneration'],'nodeId':c['expectedLndNodeId'],'at':AT.isoformat(),'flags':dict.fromkeys(a.FLAGS,False)}
        for value in [None,True,0,'false']:
            bad=copy.deepcopy(native);bad['flags']['size']=value
            with self.assertRaises(a.Refusal):a.project(bad,c,started=AT,finished=AT,elapsed=0)
        bad=copy.deepcopy(native);bad['nodeId']='03'+'a'*64
        with self.assertRaises(a.Refusal):a.project(bad,c,started=AT,finished=AT,elapsed=0)

class LndgTests(unittest.TestCase):
    def test_exact_native_key_values_and_node_scope(self):
        node='02'+'4'*64;v={'nodeId':node,'settings':dict.fromkeys(g.FLAGS.values(),'0')};self.assertEqual(g.project(v,node)['flags'],dict.fromkeys(g.FLAGS,False))
        for x in [None,0,False,'false','1']:
            bad=copy.deepcopy(v);bad['settings']['AF-Enabled']=x
            with self.assertRaises(ValueError):g.project(bad,node)
        bad=copy.deepcopy(v);del bad['settings']['AR-Enabled']
        with self.assertRaises(ValueError):g.project(bad,node)
        with self.assertRaises(ValueError):g.project(v,'03'+'3'*64)
    def test_two_fresh_native_getinfo_and_source_boundaries_no_generic_method(self):
        c=config();c.update(version=g.VERSION,nativeSourceHashes=dict.fromkeys(g.SOURCES,'a'*64));c['runtimeBinding']['imageRef']=g.IMAGE
        commands=[];boundaries=[]
        class Native:
            def binding(self):boundaries.append(True)
            def command(self,args,cap):commands.append(args);self_test.assertEqual(cap,16384);return json.dumps({'nodeId':c['expectedLndNodeId'],'settings':dict.fromkeys(g.FLAGS.values(),'0')}).encode()
        self_test=self;result=g.acquire(c,Native());self.assertEqual(result['flags'],dict.fromkeys(g.FLAGS,False));self.assertEqual(len(commands),2);self.assertEqual(len(boundaries),3)
        self.assertTrue(all(v[-1]==g.NATIVE_READ for v in commands));self.assertIn('GetInfo(ln.GetInfoRequest(),timeout=2)',g.NATIVE_READ)
        self.assertNotIn('django.setup',g.NATIVE_READ);self.assertNotIn('AddInvoice',g.NATIVE_READ);self.assertNotIn('SendPayment',g.NATIVE_READ);self.assertIn('mode=ro',g.NATIVE_READ)
    def test_native_pending_or_read_error_is_not_fabricated_false(self):
        c=config();c.update(version=g.VERSION,nativeSourceHashes=dict.fromkeys(g.SOURCES,'a'*64));c['runtimeBinding']['imageRef']=g.IMAGE
        class Native:
            def binding(self):pass
            def command(self,*args,**kwargs):raise ValueError('native pending or unknown')
        with self.assertRaises(ValueError):g.acquire(c,Native())

class LoaderTests(unittest.TestCase):
    def test_source_chain_pins_match_files_and_arguments_fail_closed(self):
        for name in ['lightningmate-native-hook','lndg-native-hook']:
            m=load(name);self.assertEqual(m.READER_SHA,hashlib.sha256((P/'lightningmate_native_reader.py').read_bytes()).hexdigest())
            ap='lightningmate_native_adapter.py' if name.startswith('lightningmate') else 'lndg_native_reader.py';self.assertEqual(m.ADAPTER_SHA,hashlib.sha256((P/ap).read_bytes()).hexdigest())
            with self.assertRaises(m.Refusal):m.arguments(['--config',m.CONFIG,'--scope','standalone'])
            with self.assertRaises(m.Refusal):m.closed_json(b'{"a":false,"a":true}')
            with self.assertRaises(m.Refusal):m.closed_json(b'{"a":NaN}')
    def test_nonprotected_wrong_exec_context_refuses_without_native_calls_or_raw_error(self):
        for name in ['lightningmate-native-hook','lndg-native-hook']:
            m=load(name);output=io.StringIO()
            with patch.object(m,'preflight',side_effect=AssertionError('must not acquire')),contextlib.redirect_stderr(output):
                self.assertEqual(m.main(['--config',m.CONFIG,'--scope','lightningmate' if name.startswith('lightningmate') else 'lndg']),1)
            self.assertEqual(output.getvalue(),'Native acquisition unavailable\n')

class NativeLndgCodecTests(unittest.TestCase):
    def run_native(self, settings_values, *, pending=False, rpc_error=False):
        import sqlite3, tempfile, types, signal
        with tempfile.TemporaryDirectory() as folder:
            path=pathlib.Path(folder)/'native.sqlite';db=sqlite3.connect(path)
            db.executescript('CREATE TABLE gui_localsettings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE gui_rebalancer(status INTEGER);')
            db.executemany('INSERT INTO gui_localsettings VALUES (?,?)',settings_values)
            if pending:db.execute('INSERT INTO gui_rebalancer VALUES (1)')
            db.commit();db.close()
            node='02'+'4'*64;events=[];connections=[];real=sqlite3.connect;test=self
            class Channel:
                def close(self):events.append('closed')
            channel=Channel()
            def connect(target,**kw):
                test.assertEqual(target,'file:/app/data/db.sqlite3?mode=ro');test.assertEqual(kw,{'uri':True,'timeout':1})
                conn=real('file:'+str(path)+'?mode=ro',uri=True);connections.append(conn);return conn
            def secure(target,creds,options):
                test.assertEqual(target,'qualified.native:10009');test.assertIs(creds,credential)
                test.assertEqual(dict(options)['grpc.max_receive_message_length'],65536);test.assertEqual(dict(options)['grpc.enable_retries'],0)
                events.append('tls');return channel
            class Stub:
                def __init__(self,actual):test.assertIs(actual,channel)
                def GetInfo(self,request,timeout):
                    test.assertEqual(timeout,2);test.assertEqual(connections[0].execute('PRAGMA query_only').fetchone()[0],1)
                    with test.assertRaises(sqlite3.OperationalError):connections[0].execute("INSERT INTO gui_localsettings VALUES('WRITE','1')")
                    events.append('GetInfo')
                    if rpc_error:raise ValueError('synthetic private native failure')
                    return types.SimpleNamespace(identity_pubkey=node,payment_preimage='PRIVATE_FIXTURE')
            credential=object();cert=pathlib.Path(folder)/'tls';cert.write_bytes(b'TLS_FIXTURE');token=pathlib.Path(folder)/'macaroon';token.write_bytes(b'PRIVATE_MACAROON_FIXTURE');lndg=types.ModuleType('lndg');lndg.settings=types.SimpleNamespace(DATABASES={'default':{'NAME':'/app/data/db.sqlite3'}},LND_RPC_SERVER='qualified.native:10009',LND_TLS_PATH=str(cert),LND_MACAROON_PATH=str(token))
            gui=types.ModuleType('gui');deps=types.ModuleType('gui.lnd_deps');deps.lightning_pb2=types.SimpleNamespace(GetInfoRequest=lambda:object());deps.lightning_pb2_grpc=types.SimpleNamespace(LightningStub=Stub)
            connector=types.ModuleType('gui.lnd_deps.lnd_connect');connector.get_creds=lambda:credential
            grpc=types.ModuleType('grpc');grpc.secure_channel=secure;grpc.ssl_channel_credentials=lambda raw:test.assertEqual(raw,b'TLS_FIXTURE');grpc.metadata_call_credentials=lambda callback:callback(None,lambda metadata,error:test.assertEqual(metadata,[('macaroon',b'PRIVATE_MACAROON_FIXTURE'.hex())]));grpc.composite_channel_credentials=lambda *args:credential;out=io.StringIO();modules={'lndg':lndg,'gui':gui,'gui.lnd_deps':deps,'gui.lnd_deps.lnd_connect':connector,'grpc':grpc}
            try:
                with patch.dict(sys.modules,modules),patch.object(sqlite3,'connect',side_effect=connect),patch.object(signal,'signal'),patch.object(signal,'setitimer'),contextlib.redirect_stdout(out):exec(compile(g.NATIVE_READ,'fixed-native-read','exec'),{})
            except BaseException as error:result=error
            else:result=json.loads(out.getvalue())
            for conn in connections:
                with self.assertRaises(sqlite3.ProgrammingError):conn.execute('SELECT 1')
            reread=real(path);self.assertEqual(reread.execute('SELECT count(*) FROM gui_localsettings').fetchone()[0],len(settings_values));reread.close()
            self.assertNotIn('PRIVATE_FIXTURE',out.getvalue());self.assertNotIn('PRIVATE_MACAROON',out.getvalue());self.assertNotIn(b'PRIVATE_MACAROON_FIXTURE'.hex(),out.getvalue());return result,events
    def test_real_native_readonly_sql_and_only_getinfo_with_channel_close(self):
        result,events=self.run_native([(key,'0') for key in g.FLAGS.values()]);self.assertEqual(g.project(result,'02'+'4'*64)['flags'],dict.fromkeys(g.FLAGS,False));self.assertEqual(events,['tls','GetInfo','closed'])
    def test_missing_settings_or_pending_work_refuses_before_rpc(self):
        for settings,pending in [([(key,'0') for key in list(g.FLAGS.values())[:2]],False),([(key,'0') for key in g.FLAGS.values()],True)]:
            result,events=self.run_native(settings,pending=pending);self.assertIsInstance(result,ValueError);self.assertEqual(events,[])
    def test_rpc_failure_closes_channel_and_readonly_transaction(self):
        result,events=self.run_native([(key,'0') for key in g.FLAGS.values()],rpc_error=True);self.assertIsInstance(result,ValueError);self.assertEqual(events,['tls','GetInfo','closed'])

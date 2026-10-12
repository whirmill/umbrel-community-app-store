"""Offline producer regressions; no Docker, CLI, native or credential call."""
import unittest,pathlib,sys,importlib.util,json,copy,time,hashlib,types,stat
from unittest.mock import patch
BASE=pathlib.Path(__file__).resolve().parents[1];sys.path.insert(0,str(BASE))
sp=importlib.util.spec_from_file_location('app_producer',BASE/'app-control-producer.py');p=importlib.util.module_from_spec(sp);sp.loader.exec_module(p)
q=p.projection
NODE='02'+'1'*64;RUNTIME={'containerId':'1'*64,'imageRef':'ghcr.io/fixture/app@sha256:'+'2'*64,'imageId':'sha256:'+'3'*64}
def contract():return {'schema':1,'scope':'apps-only','appIds':q.IDS.copy(),'hostBootId':'11111111-1111-1111-1111-111111111111','generation':1,'sourceHash':'a'*64,'producerHash':'b'*64,'runtimeBinding':RUNTIME,'expectedLndNodeId':NODE,'docker':'/usr/bin/docker','cli':'/usr/local/bin/umbreld','runtimeGeneration':{'startedAt':'2026-10-12T18:00:00Z','restartCount':0}}
def row(cid='4'*64,name='lightningmate_web_1',project='lightningmate'):return {'id':cid,'name':name,'project':project}
def inspected(r):return {**r,'name':'/'+r['name'],'state':'running','imageRef':RUNTIME['imageRef'],'imageId':RUNTIME['imageId'],'startedAt':'2026-10-12T18:00:00Z','restartCount':0}
class Source:
 def __init__(self):self.calls=[];self.turn=0
 def boot(self):self.turn+=1;return contract()['hostBootId']
 def runtime(self):return RUNTIME
 def node(self):return {'nodeId':NODE,'network':'bitcoin/mainnet'}
 def registry(self):return dict.fromkeys(q.IDS,False)
 def lifecycle(self,app):self.calls.append(('lifecycle',app));return 'not-installed'
 def containers(self,app):self.calls.append(('containers',app));return []
 def installed_facts(self,app):raise AssertionError('absent app must not trigger hooks')
class Producer(unittest.TestCase):
 def test_exact_two_boundaries_all_four_no_standalone(self):
  s=Source();out=p.acquire(s,contract(),clock=lambda:'2026-10-12T18:00:00Z');self.assertEqual(s.turn,2);self.assertEqual(len(s.calls),16);self.assertEqual(out['standalone'],'unknown');self.assertNotIn('otherAutomationBefore',out);self.assertEqual(out['before'],out['after']);self.assertEqual([v['id'] for v in out['before']],q.IDS)
 def test_registry_unknown_and_container_or_lifecycle_failure_never_becomes_absent(self):
  for method in ('registry','containers','lifecycle'):
   s=Source()
   def fail(*_):raise ValueError('PRIVATE_NATIVE_CANARY')
   setattr(s,method,fail);out=p.acquire(s,contract(),clock=lambda:'2026-10-12T18:00:00Z');self.assertTrue(all(v['lifecycle']=='unknown' for v in out['before']));self.assertNotIn('PRIVATE_NATIVE_CANARY',json.dumps(out))
 def test_reinstall_and_node_runtime_boot_drift_preserved_or_refused(self):
  s=Source();s.registry=lambda:dict.fromkeys(q.IDS,s.turn==2);out=p.acquire(s,contract(),clock=lambda:'2026-10-12T18:00:00Z');self.assertNotEqual(out['before'],out['after'])
  for method,wrong in [('boot','wrong'),('runtime',{}),('node',{'nodeId':'03'+'2'*64,'network':'bitcoin/mainnet'})]:
   s=Source();setattr(s,method,lambda:wrong)
   with self.assertRaises(ValueError):p.acquire(s,contract())
 def test_or_filters_union_dedupe_overfetch_and_exact_inspection(self):
  c=contract();calls=[];a=row();b=row('5'*64,'lightningmate_custom_1','other');over=row('6'*64,'other_lightningmate_named','other')
  def run(argv,**kw):
   calls.append(argv);self.assertLessEqual(kw['timeout'],5)
   if 'ps' in argv:
    self.assertIn('-a',argv);self.assertIn('--no-trunc',argv);self.assertEqual(argv.count('--filter'),1)
    expr=argv[argv.index('--filter')+1];return '\n'.join(json.dumps(v) for v in ([a] if expr.startswith('label=') else [a,b,over]))
   cid=argv[-1];self.assertEqual(len(cid),64);return json.dumps(inspected(a if cid==a['id'] else b))
  source=p.HostSource(c,time.monotonic()+90,run);result=source.containers('lightningmate');self.assertEqual(len(result),2);self.assertEqual(len(calls),4);self.assertEqual([a[a.index('--filter')+1] for a in calls[:2]],['label=com.docker.compose.project=lightningmate','name=lightningmate']);self.assertNotIn(over['id'],json.dumps(result))
 def test_all_four_filter_queries_are_separate_scoped_and_no_global_command(self):
  calls=[]
  def run(argv,**kw):calls.append(argv);return ''
  source=p.HostSource(contract(),time.monotonic()+90,run)
  for app in q.IDS:self.assertEqual(source.containers(app),[])
  self.assertEqual(len(calls),8);self.assertTrue(all(a.count('--filter')==1 for a in calls))
  with self.assertRaises(ValueError):source.containers('other')
 def test_inspect_mutation_conflicting_union_and_caps_fail_closed(self):
  a=row()
  for kind in ('inspect','union','cap'):
   def run(argv,**kw):
    if 'inspect' in argv:return json.dumps(inspected({**a,'name':'changed'}))
    if kind=='cap':return '\n'.join(json.dumps(row(f'{i:064x}','lightningmate_'+str(i))) for i in range(33))
    if kind=='union' and argv[argv.index('--filter')+1].startswith('name='):return json.dumps({**a,'name':'lightningmate_changed'})
    return json.dumps(a)
   with self.assertRaises(ValueError):p.HostSource(contract(),time.monotonic()+90,run).containers('lightningmate')
 def test_registry_reads_only_fixed_apps_key_not_missing_config_as_absence(self):
  self.assertEqual(p.registry('hostname: private\napps: []\nsecret: private'),dict.fromkeys(q.IDS,False))
  self.assertTrue(p.registry('apps:\n  - lightningmate\n  - unrelated\nsecret: private')['lightningmate'])
  for raw in ('missing: []','apps: null','apps:\n','apps:\n  - lightningmate\n  - lightningmate','apps: []\n  - lndg'):
   with self.assertRaises(ValueError):p.registry(raw)
 def test_native_unknown_enabled_wrong_node_and_private_contract_metadata_are_safe(self):
  c=contract();c['installedQualifications']={'lndg':{'runtimeBinding':RUNTIME,'version':'1.11.1','hook':{'sourceHash':'d'*64,'config':'PRIVATE_CONFIG'},'transport':{'jwtFile':'PRIVATE_TOKEN'}}}
  public=q.public_contract(c);self.assertNotIn('PRIVATE_',json.dumps(public));facts={'runtimeBinding':RUNTIME,'version':'1.11.1','sourceHash':'d'*64,'settingsDigest':'e'*64,'nodeId':NODE,'flags':{'lndgAF':False,'lndgAR':False,'lndgAutopilot':False}};self.assertEqual(q.qualification('lndg',facts,c)['flags'],facts['flags'])
  for mutate in (lambda f:f['flags'].update(lndgAF=True),lambda f:f['flags'].pop('lndgAR'),lambda f:f.update(nodeId='03'+'2'*64)):
   f=copy.deepcopy(facts);mutate(f)
   with self.assertRaises(ValueError):q.qualification('lndg',f,c)
 def test_lifecycle_uses_only_normal_root_four_id_queries_no_token_or_fallback(self):
  calls=[]
  def run(argv,**kw):calls.append(argv);return json.dumps({'state':'not-installed','progress':100})
  source=p.HostSource(contract(),time.monotonic()+90,run)
  for app in q.IDS:self.assertEqual(source.lifecycle(app),'not-installed')
  self.assertEqual(calls,[[contract()['cli'],'client','apps.state.query','--appId',app] for app in q.IDS]);self.assertNotIn('token',json.dumps(calls))
 def test_node_exact_stdout_and_warning_profile_unknown_errors_do_not_grant(self):
  c=contract();code=(BASE/'app-control-node-probe.cjs').read_bytes();c['nodeProbe']={'path':str(BASE/'app-control-node-probe.cjs'),'sourceHash':hashlib.sha256(code).hexdigest(),'input':{'public':'SYNTHETIC_CONFIG'}}
  warning=b'(node:123) [DEP0123] DeprecationWarning: Setting the TLS ServerName to an IP address is not permitted by RFC 6066. This will be ignored in a future version.\n(Use `node --trace-deprecation ...` to show where the warning was created)\n'
  for err,accepted in [(b'',True),(warning,True),(warning+b'PRIVATE_CANARY',False),(b'x'*len(warning),False)]:
   def run(argv,**kw):self.assertEqual(argv[argv.index('exec')+1:argv.index('exec')+7],['--user','1000:1000','--workdir','/app','-i',RUNTIME['containerId']]);return json.dumps({'schema':1,'nodeId':NODE,'network':'bitcoin/mainnet','resourcesClosed':True}).encode(),err
   with patch.object(p.host_read_boundary,'read_bytes',return_value=code):
    if accepted:self.assertEqual(p.HostSource(c,time.monotonic()+90,run).node()['nodeId'],NODE)
    else:
     with self.assertRaises(ValueError):p.HostSource(c,time.monotonic()+90,run).node()
 def test_closed_json_duplicates_nonfinite_and_contract_scalar_canaries_refused(self):
  for raw in ('{"schema":1,"schema":2}','{"generation":NaN}'):
   with self.assertRaises(ValueError):p.closed(raw)
  for field in ('generation','sourceHash','hostBootId','expectedLndNodeId'):
   c=contract();c[field]={'secret':'PRIVATE_CANARY'}
   with self.assertRaises((ValueError,TypeError)):q.public_contract(c)
 def test_source_import_bundle_refuses_user_owned_or_writable_ancestors_before_import(self):
  with patch.object(pathlib.Path,'lstat',return_value=types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=1000,st_nlink=1)):
   with self.assertRaises(ValueError):p.protected_bundle()
 def test_command_deadline_and_output_cap_reap_only_owned_child(self):
  # Local public fixture processes only; no Docker/native/network/credentials.
  with self.assertRaises(Exception):p.command([sys.executable,'-I','-S','-c','import time; time.sleep(2)'],timeout=0.03,cap=1024)
  with self.assertRaises(ValueError):p.command([sys.executable,'-I','-S','-c','print("x"*2048)'],timeout=1,cap=1024)
  self.assertEqual(p.command([sys.executable,'-I','-S','-c','print("public")'],timeout=1,cap=1024),'public\n')
if __name__=='__main__':unittest.main()

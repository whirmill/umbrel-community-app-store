#!/usr/bin/env python3
"""Root-only finite four-app reader. Never authorizes finances or scans standalone jobs."""
import datetime as dt,hashlib,json,os,pathlib,re,resource,signal,stat,subprocess,sys,tempfile,time
sys.dont_write_bytecode=True
def protected_bundle():
 # Admit the finite local import bundle before running any locally imported code.
 directory=pathlib.Path(__file__).absolute().parent
 for path in [directory,*directory.parents]:
  st=path.lstat()
  if not stat.S_ISDIR(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022:raise ValueError('source_ancestry')
 for name in ['app-control-producer.py','app_controls_projection.py','host_read_boundary.py','host_qualification.py','alby_transport.py','alby_readonly.py']:
  st=(directory/name).lstat()
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=0 or st.st_mode&0o022 or st.st_nlink!=1:raise ValueError('source_file')
if __name__=='__main__':
 try:
  if os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site:raise ValueError('execution')
  protected_bundle()
 except Exception:
  sys.stderr.write('Protected root source execution required\n');sys.exit(1)
sys.path.insert(0,str(pathlib.Path(__file__).absolute().parent))
import app_controls_projection as projection,host_read_boundary,host_qualification,alby_transport
IDS=projection.IDS
FORMAT='{"id":{{json .ID}},"name":{{json .Names}},"project":{{json (.Label "com.docker.compose.project")}}}'
INSPECT='{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"state":{{json .State.Status}},"imageRef":{{json .Config.Image}},"imageId":{{json .Image}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}}}'
DEP0123=re.compile(rb'\(node:[1-9][0-9]{0,9}\) \[DEP0123\] DeprecationWarning: Setting the TLS ServerName to an IP address is not permitted by RFC 6066\. This will be ignored in a future version\.\n\(Use `node --trace-deprecation \.\.\.` to show where the warning was created\)\n')
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/var/empty','LANG':'C','LC_ALL':'C','PYTHONDONTWRITEBYTECODE':'1'}
def closed(raw):
 def pairs(rows):
  result={}
  for k,v in rows:
   if k in result:raise ValueError('json')
   result[k]=v
  return result
 return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('json')))
def registry(raw):
 lines=raw.splitlines();positions=[i for i,l in enumerate(lines) if l.startswith('apps:')]
 if len(positions)!=1:raise ValueError('registry')
 index=positions[0];tail=lines[index][5:].strip();ids=[]
 if tail not in ('','[]'):raise ValueError('registry')
 for line in lines[index+1:]:
  if line and not line[0].isspace() and not line.startswith(('-','#')):break
  if not line.strip() or line.lstrip().startswith('#'):continue
  match=re.fullmatch(r'(?:  )?- ([a-z0-9-]{1,64})',line)
  if not match or tail=='[]':raise ValueError('registry')
  ids.append(match[1])
 if len(ids)>512 or len(set(ids))!=len(ids) or tail=='' and not ids:raise ValueError('registry')
 return {app:app in ids for app in IDS}
def retained(app,row):return row['project']==app or row['name'].startswith((app+'_',app+'-'))
def command(argv,*,timeout=5,cap=65536,data=None,with_stderr=False):
 def limits():resource.setrlimit(resource.RLIMIT_FSIZE,(cap,cap))
 with tempfile.TemporaryFile() as out,tempfile.TemporaryFile() as err,tempfile.TemporaryFile() as inp:
  if data is not None:inp.write(data);inp.seek(0)
  child=subprocess.Popen(argv,stdin=inp if data is not None else subprocess.DEVNULL,stdout=out,stderr=err,env=ENV,start_new_session=True,preexec_fn=limits)
  try:
   child.wait(timeout=timeout)
   if child.returncode or out.tell()>=cap or err.tell()>=cap:raise ValueError('command')
   out.seek(0);err.seek(0);body,error=out.read(cap),err.read(cap)
   if not with_stderr and error:raise ValueError('command')
   return (body,error) if with_stderr else body.decode('utf8')
  finally:
   try:os.killpg(child.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   child.wait()
class HostSource:
 def __init__(self,config,deadline,run=command):
  self.c,self.deadline,self.run=config,deadline,run;self.docker=[config['docker'],'--host=unix:///var/run/docker.sock','--config=/var/empty']
 def call(self,args,timeout=5,cap=65536,**kw):
  left=self.deadline-time.monotonic()
  if left<=0:raise ValueError('deadline')
  return self.run(args,timeout=min(timeout,left),cap=cap,**kw)
 def boot(self):return host_read_boundary.read_bytes(pathlib.Path('/proc/sys/kernel/random/boot_id'),128).decode().strip()
 def runtime(self):
  expected=self.c['runtimeBinding'];row=closed(self.call([*self.docker,'inspect','--format',INSPECT,expected['containerId']],cap=4096));actual={k:row[v] for k,v in [('containerId','id'),('imageRef','imageRef'),('imageId','imageId')]}
  if actual!=expected or row['state']!='running' or row['startedAt']!=self.c['runtimeGeneration']['startedAt'] or row['restartCount']!=self.c['runtimeGeneration']['restartCount']:raise ValueError('runtime')
  return actual
 def node(self):
  spec=self.c['nodeProbe'];path=pathlib.Path(spec['path']);code=host_read_boundary.read_bytes(path,1048576,protected=True)
  if hashlib.sha256(code).hexdigest()!=spec['sourceHash']:raise ValueError('node_source')
  body,err=self.call([*self.docker,'exec','--user','1000:1000','--workdir','/app','-i',self.c['runtimeBinding']['containerId'],'node','-e',code.decode()],timeout=8,cap=4096,data=json.dumps(spec['input'],separators=(',',':')).encode(),with_stderr=True)
  # Safe stdout is decoded privately; mixed/unknown warnings never become a proof.
  v=closed(body)
  if set(v)!={'schema','nodeId','network','resourcesClosed'} or v['schema']!=1 or v['nodeId']!=self.c['expectedLndNodeId'] or v['network']!='bitcoin/mainnet' or v['resourcesClosed'] is not True or err and not DEP0123.fullmatch(err):raise ValueError('node')
  return {'nodeId':v['nodeId'],'network':v['network']}
 def registry(self):return registry(host_read_boundary.read_bytes(pathlib.Path('/home/umbrel/umbrel/umbrel.yaml'),1048576).decode())
 def lifecycle(self,app):
  if app not in IDS:raise ValueError('scope')
  v=closed(self.call([self.c['cli'],'client','apps.state.query','--appId',app],cap=4096))
  if set(v)!={'state','progress'} or type(v['progress']) not in (int,float) or not 0<=v['progress']<=100 or v['state'] not in ('not-installed','running','stopped'):raise ValueError('lifecycle')
  return v['state']
 def containers(self,app):
  if app not in IDS:raise ValueError('scope')
  rows={}
  # Separate queries implement OR. Name is a substring filter, refined locally.
  for expr in ('label=com.docker.compose.project='+app,'name='+app):
   raw=self.call([*self.docker,'ps','-a','--no-trunc','--filter',expr,'--format',FORMAT],cap=16384)
   for line in raw.splitlines():
    row=closed(line)
    if set(row)!={'id','name','project'} or not projection.HASH.fullmatch(row.get('id','')) or not isinstance(row.get('name'),str) or not re.fullmatch(r'[a-zA-Z0-9_.-]{1,128}',row['name']) or row['project'] is not None and (not isinstance(row['project'],str) or len(row['project'])>64):raise ValueError('container')
    row['project']=row['project'] or ''
    if retained(app,row):
     if row['id'] in rows and rows[row['id']]!=row:raise ValueError('container')
     rows[row['id']]=row
     if len(rows)>32:raise ValueError('container_cap')
  result=[]
  for cid,row in sorted(rows.items()):
   info=closed(self.call([*self.docker,'inspect','--format',INSPECT,cid],cap=4096));info['name']=info['name'].removeprefix('/');info['project']=info['project'] or ''
   if set(info)!=set(['id','name','project','state','imageRef','imageId','startedAt','restartCount']) or any(info[k]!=row[k] for k in row) or info['state'] not in ('running','exited','created') or type(info['restartCount']) is not int or info['restartCount']<0 or not isinstance(info['imageRef'],str) or not re.fullmatch(r'[a-zA-Z0-9./:@_-]{1,256}',info['imageRef']) or not re.fullmatch(r'sha256:[a-f0-9]{64}',info['imageId']):raise ValueError('container_drift')
   result.append(info)
  return result
 def installed_facts(self,app):
  q=self.c.get('installedQualifications',{}).get(app)
  if not q:raise ValueError('qualification')
  if app=='albyhub':
   # Existing transport must independently bind the reviewed current container route.
   t=q['transport'];cid=q['runtimeBinding']['containerId']
   if t.get('scheme')=='http':
    ports=closed(self.call([*self.docker,'inspect','--format','{{json .NetworkSettings.Ports}}',cid],cap=16384));key=t.get('containerPort')
    if not isinstance(key,str) or not re.fullmatch(r'[0-9]{1,5}/tcp',key) or not any(p.get('HostIp') in ['127.0.0.1','::1','0.0.0.0','::'] and p.get('HostPort')==str(t.get('port')) for p in ports.get(key,[]) or []):raise ValueError('route')
   facts=alby_transport.qualify(t,self.c.get('albyQualification',{}));return {'backendFacts':facts,'runtimeBinding':q['runtimeBinding']}
  facts=host_qualification.run_hook(q['hook'],app,self.c,self.call)
  return {**facts,'runtimeBinding':q['runtimeBinding'],'version':q['version'],'sourceHash':q['hook']['sourceHash']}
def acquire(source,c,clock=lambda:dt.datetime.now(dt.timezone.utc).isoformat()):
 public=projection.public_contract(c);at=clock()
 def boundary():
  boot,runtime,node=source.boot(),source.runtime(),source.node()
  if boot!=c['hostBootId'] or runtime!=c['runtimeBinding'] or node!={'nodeId':c['expectedLndNodeId'],'network':'bitcoin/mainnet'}:raise ValueError('binding')
  try:installed=source.registry()
  except Exception:installed=None
  states=[]
  for app in IDS:
   state=projection.unknown(app)
   try:
    if installed is None:raise ValueError('registry')
    state.update(durableInstalled=installed[app],lifecycle=source.lifecycle(app),containers=source.containers(app))
    if installed[app]:
     if state['lifecycle'] not in ('running','stopped'):raise ValueError('lifecycle')
     facts=source.installed_facts(app);q=projection.qualification(app,facts,c)
     if not any(r['id']==q['runtimeBinding']['containerId'] and r['imageRef']==q['runtimeBinding']['imageRef'] and r['imageId']==q['runtimeBinding']['imageId'] for r in state['containers']):raise ValueError('container_binding')
     state['qualification']=q
   except Exception:state['qualification']=None;state['lifecycle']='unknown'
   states.append(state)
  seen=[r['id'] for state in states for r in state['containers']]
  if len(seen)!=len(set(seen)):raise ValueError('ambiguous_app_container')
  return {'boot':boot,'runtime':runtime,'node':node,'registryHash':projection.digest(installed) if installed is not None else None,'states':states}
 before,after=boundary(),boundary();ended=clock()
 if any(before[k]!=after[k] for k in ('boot','runtime','node')):raise ValueError('binding_changed')
 # Unequal app observations remain explicit per-app unknown to the consumer.
 return {**{k:public[k] for k in ['schema','scope','hostBootId','generation','sourceHash','producerHash','runtimeBinding','appIds']},'at':at,'endedAt':ended,'node':before['node'],'registryBeforeHash':before['registryHash'],'registryAfterHash':after['registryHash'],'before':before['states'],'after':after['states'],'standalone':'unknown'}
def write(path,value):
 parent=host_read_boundary.parent_fd(path,protected=True);name=None
 try:
  raw=json.dumps(value,separators=(',',':')).encode()
  if len(raw)>65536:raise ValueError('output_cap')
  name='.app-controls-'+os.urandom(16).hex();fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444,dir_fd=parent)
  with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
  os.rename(name,path.name,src_dir_fd=parent,dst_dir_fd=parent);name=None;os.fsync(parent)
 finally:
  if name is not None:os.unlink(name,dir_fd=parent)
  os.close(parent)
def main(argv=None):
 import argparse
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--config',type=pathlib.Path,required=True);p.add_argument('--output-directory',type=pathlib.Path,required=True);args=p.parse_args(argv)
 if os.geteuid()!=0 or not sys.flags.isolated or not sys.flags.no_site:p.exit(1,'Protected root execution required\n')
 try:
  raw=host_read_boundary.read_bytes(args.config,65536,protected=True);c=closed(raw);projection.public_contract(c)
  if c['producerHash']!=hashlib.sha256(host_read_boundary.read_bytes(pathlib.Path(__file__),1048576,protected=True)).hexdigest() or c['sourceHash']!=hashlib.sha256(host_read_boundary.read_bytes(pathlib.Path(projection.__file__),1048576,protected=True)).hexdigest():raise ValueError('source')
  for m in [host_read_boundary,host_qualification,alby_transport,alby_transport.alby_readonly]:
   path=pathlib.Path(m.__file__)
   if hashlib.sha256(host_read_boundary.read_bytes(path,1048576,protected=True)).hexdigest()!=c['moduleHashes'].get(path.name):raise ValueError('module')
  for cmd in (c['cli'],c['docker'],sys.executable):
   if hashlib.sha256(host_read_boundary.read_bytes(pathlib.Path(cmd),67108864,protected=True)).hexdigest()!=c['commandHashes'].get(cmd):raise ValueError('binary')
  parent=host_read_boundary.parent_fd(pathlib.Path('/var/empty/entry'),protected=True)
  try:
   if os.listdir(parent):raise ValueError('docker_config')
  finally:os.close(parent)
  result=acquire(HostSource(c,time.monotonic()+90),c)
  if host_read_boundary.read_bytes(args.config,65536,protected=True)!=raw:raise ValueError('config_changed')
  write(args.output_directory/'contract.json',projection.public_contract(c));write(args.output_directory/'status.json',result)
 except Exception:p.exit(1,'Scoped app acquisition unavailable; previous proof must expire\n')
if __name__=='__main__':main()

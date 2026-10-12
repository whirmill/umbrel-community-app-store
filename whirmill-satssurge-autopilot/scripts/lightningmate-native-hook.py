"""Protected LM hook candidate. No install or native admission is implied."""
# Bootstrap below requires separately qualified protected Python/stdlib runtime.
import sys
sys.dont_write_bytecode=True
import os,stat,hashlib,json,time,datetime,signal,types,importlib.machinery
ROOT='/usr/local/lib/satssurge-native-host'
CONFIG=ROOT+'/lightningmate-config.json'
OWNER=ROOT+'/owner-contract.json'
MANIFEST=ROOT+'/python-imports.json'
ENTRY=ROOT+'/lightningmate-native-hook.py'
READER=ROOT+'/lightningmate_native_reader.py'
ADAPTER=ROOT+'/lightningmate_native_adapter.py'
PYTHON='/usr/bin/python3.13'
DOCKER='/usr/bin/docker'
BOOT='/proc/sys/kernel/random/boot_id'
EMPTY_PROPOSAL=ROOT+'/empty'
READER_SHA='7466315027082cf3f4ba94aa3eb09c64e478c5280d49714c84d5a410d922f2fb'
ADAPTER_SHA='b1853e6a243c042b81cc9b4fc27e7bd5e397618759e6bfb85a436adf33122de9'
DOCKER_SHA=None
CONFIG_KEYS={'schema','referenceMode','hostBootId','generation','expectedLndNodeId','version','nativeSourceHashes','runtimeBinding','runtimeGeneration','readerSha256','adapterSha256','pythonSha256','dockerSha256','runtimeManifestSha256','endpoint'}
HEX=set('0123456789abcdef')
class Refusal(Exception):pass
class Deadline(BaseException):pass
def digest(value):return hashlib.sha256(value).hexdigest()
def hexhash(value):return isinstance(value,str) and len(value)==64 and set(value)<=HEX
def canonical(path):
    if not isinstance(path,str) or not path.startswith('/') or os.path.normpath(path)!=path or '..' in path.split('/') or '//' in path:raise Refusal('path')
    return path.split('/')[1:]
def metadata(info,*,directory=False,limit=65536):
    if info.st_uid!=0 or info.st_mode&0o022:raise Refusal('ownership')
    if directory:
        if not stat.S_ISDIR(info.st_mode):raise Refusal('directory')
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>limit:raise Refusal('regular_input')
def protected_read(path,limit=65536):
    parts=canonical(path);parent=fd=None
    try:
        parent=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);metadata(os.fstat(parent),directory=True)
        for part in parts[:-1]:
            following=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
            try:metadata(os.fstat(following),directory=True)
            except BaseException:os.close(following);raise
            os.close(parent);parent=following
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=parent)
        before=os.fstat(fd);metadata(before,limit=limit);data=bytearray()
        while len(data)<=limit:
            block=os.read(fd,min(65536,limit+1-len(data)))
            if not block:break
            data.extend(block)
        after=os.fstat(fd);selected=os.stat(parts[-1],dir_fd=parent,follow_symlinks=False)
        keys=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_nlink,s.st_uid,s.st_mode)
        if len(data)>limit or keys(before)!=keys(after) or keys(after)!=keys(selected):raise Refusal('changed_input')
        return bytes(data)
    finally:
        if fd is not None:os.close(fd)
        if parent is not None:os.close(parent)
def closed_json(raw):
    def pairs(items):
        result={}
        for key,value in items:
            if key in result:raise Refusal('duplicate_key')
            result[key]=value
        return result
    try:return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(Refusal('json_constant')))
    except Refusal:raise
    except Exception:raise Refusal('json') from None
def arguments(argv):
    if argv!=['--config',CONFIG,'--scope','lightningmate']:raise Refusal('argv')
def validate_config(c):
    if not isinstance(c,dict) or set(c)!=CONFIG_KEYS or type(c['schema']) is not int or c['schema']!=1 or c['referenceMode']!='protected-native-acquisition-v1':raise Refusal('config_schema')
    if type(c['generation']) is not int or c['generation']<0 or not isinstance(c['hostBootId'],str) or len(c['hostBootId'])!=36:raise Refusal('owner_unknown')
    if c['readerSha256']!=READER_SHA or c['adapterSha256']!=ADAPTER_SHA or not hexhash(c['dockerSha256']) or not hexhash(c['pythonSha256']) or not hexhash(c['runtimeManifestSha256']):raise Refusal('chain_pin')
    if c['version']!='0.7.7' or not isinstance(c['expectedLndNodeId'],str) or len(c['expectedLndNodeId'])!=66 or set(c['expectedLndNodeId'])-HEX:raise Refusal('native_identity')
    if not isinstance(c['nativeSourceHashes'],dict) or len(c['nativeSourceHashes'])!=4 or not all(hexhash(v) for v in c['nativeSourceHashes'].values()):raise Refusal('native_sources')
    if not isinstance(c['runtimeBinding'],dict) or set(c['runtimeBinding'])!={'containerId','imageRef','imageId'}:raise Refusal('runtime_binding')
    g=c['runtimeGeneration']
    if not isinstance(g,dict) or set(g)!={'startedAt','restartCount'} or not isinstance(g['startedAt'],str) or type(g['restartCount']) is not int or g['restartCount']<0:raise Refusal('runtime_generation')
def preflight(read=protected_read):
    raw=read(CONFIG);c=closed_json(raw);validate_config(c)
    owner=closed_json(read(OWNER));boot=read(BOOT,128).decode('ascii').strip()
    if not isinstance(owner,dict) or owner.get('hostBootId')!=boot or c['hostBootId']!=boot or type(owner.get('generation')) is not int or owner['generation']!=c['generation'] or owner.get('expectedLndNodeId')!=c['expectedLndNodeId']:raise Refusal('current_owner')
    entry=read(ENTRY,1048576);entrysha=digest(entry)
    expected={'contract':'satssurge-native-host-hook-v1','path':ENTRY,'sourceHash':entrysha,'python':PYTHON,'pythonHash':c['pythonSha256'],'config':CONFIG,'configHash':digest(raw)}
    try:qualification=owner['installedQualifications']['lightningmate']
    except Exception:raise Refusal('owner_hook') from None
    if qualification.get('hook')!=expected or qualification.get('version')!=c['version'] or qualification.get('runtimeBinding')!=c['runtimeBinding']:raise Refusal('owner_hook')
    if digest(read(PYTHON,67108864))!=c['pythonSha256'] or digest(read(DOCKER,67108864))!=c['dockerSha256']:raise Refusal('binary_pin')
    reader=read(READER,1048576);adapter=read(ADAPTER,1048576)
    if digest(reader)!=READER_SHA or digest(adapter)!=ADAPTER_SHA:raise Refusal('import_pin')
    manifest=read(MANIFEST,65536)
    if digest(manifest)!=c['runtimeManifestSha256']:raise Refusal('runtime_manifest_pin')
    m=closed_json(manifest)
    if not isinstance(m,dict) or set(m)!={'schema','modules'} or type(m['schema']) is not int or m['schema']!=1 or not isinstance(m['modules'],dict) or not 1<=len(m['modules'])<=256:raise Refusal('runtime_manifest')
    for name,row in m['modules'].items():
        if not isinstance(name,str) or not name or any(not part.isidentifier() for part in name.split('.')) or not isinstance(row,dict) or set(row)!={'path','sha256'} or not hexhash(row['sha256']):raise Refusal('runtime_manifest')
        canonical(row['path'])
        if not row['path'].startswith('/usr/lib/python3.13/') or not row['path'].endswith(('.py','.so')):raise Refusal('runtime_origin')
        if digest(read(row['path'],67108864))!=row['sha256']:raise Refusal('runtime_import_pin')
    c={**c,'hookSourceHash':entrysha}
    return c,reader,adapter,m['modules']
class ImportGuard:
    def __init__(self,manifest,read=protected_read):self.manifest=manifest;self.read=read
    def check(self,name,origin):
        row=self.manifest.get(name)
        if not row or row['path']!=origin:raise Refusal('public_import_pin')
        source=self.read(origin,67108864)
        if digest(source)!=row['sha256']:raise Refusal('public_import_pin')
        return source
    def loaded(self):
        for name,module in list(sys.modules.items()):
            if name=='__main__':continue
            spec=getattr(module,'__spec__',None)
            if spec and spec.origin not in [None,'built-in','frozen']:self.check(name,spec.origin)
    def find_spec(self,fullname,path=None,target=None):
        spec=importlib.machinery.PathFinder.find_spec(fullname,path)
        if spec:
            source=self.check(fullname,spec.origin)
            if spec.origin.endswith('.py'):
                spec.loader=VerifiedSource(source,spec.origin)
        return spec

class VerifiedSource:
    def __init__(self,source,path):self.source=source;self.path=path
    def create_module(self,spec):return None
    def exec_module(self,module):exec(compile(self.source,self.path,'exec'),module.__dict__)

def load_verified(name,path,source,expected):
    if digest(source)!=expected:raise Refusal('import_pin')
    module=types.ModuleType(name);module.__file__=path
    # Execute verified bytes directly, avoiding path reopen or import-cache reads.
    exec(compile(source,path,'exec'),module.__dict__)
    return module

def execute(c,reader_bytes,adapter_bytes,manifest,*,wall=lambda:datetime.datetime.now(datetime.timezone.utc),monotonic=time.monotonic):
    guard=ImportGuard(manifest);guard.loaded();sys.meta_path.insert(0,guard)
    try:
        reader=load_verified('satssurge_lm_pinned_reader',READER,reader_bytes,READER_SHA)
        adapter=load_verified('satssurge_lm_pinned_adapter',ADAPTER,adapter_bytes,ADAPTER_SHA)
        reader.configure(c)
        if c['nativeSourceHashes']!=reader.SOURCES:raise Refusal('native_pin')
        # Config generation expectation is seeded BEFORE the reader's first
        # binding, so a known restart mismatch is rejected before password/auth.
        original=reader.Docker
        class PinnedGenerationDocker(original):
            def __init__(self,budget):super().__init__(budget);self.generation=dict(c['runtimeGeneration'])
        reader.Docker=PinnedGenerationDocker
        payload=adapter.acquire(reader,c,reader_file_sha256=READER_SHA,wall=wall,monotonic=monotonic)
        # Recheck current owner/config/boot after actual acquisition. Changes fail
        # closed without emitting a proof or replaying the normal auth sequence.
        current,rb,ab,mm=preflight()
        if current!=c or rb!=reader_bytes or ab!=adapter_bytes or mm!=manifest:raise Refusal('owner_changed')
        return adapter.encode(payload)
    finally:sys.meta_path.remove(guard)
def main(argv=None):
    previous=None
    try:
        arguments(sys.argv[1:] if argv is None else argv)
        if os.geteuid()!=0 or sys.executable!=PYTHON or sys.argv[0]!=ENTRY or __file__!=ENTRY or not sys.flags.isolated or not sys.flags.no_site:raise Refusal('execution_context')
        os.environ.clear();os.environ.update({'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/nonexistent','LANG':'C','LC_ALL':'C'})
        def deadline(*_):raise Deadline()
        previous=signal.signal(signal.SIGALRM,deadline);signal.setitimer(signal.ITIMER_REAL,6)
        c,rb,ab,m=preflight();body=execute(c,rb,ab,m)
        if len(body)>=16384:raise Refusal('output_cap')
        sys.stdout.buffer.write(body+b'\n');sys.stdout.buffer.flush();return 0
    except (Exception,Deadline):
        # No exception text, config, environment, raw body or credential output.
        sys.stderr.write('Native acquisition unavailable\n');return 1
    finally:
        if previous is not None:signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)
if __name__=='__main__':raise SystemExit(main())

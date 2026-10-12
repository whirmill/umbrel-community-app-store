"""Host-only candidate. Mock-reviewed first; live invocation separately assigned.

Only sanitized projection leaves the host. Never import app modules/auth secrets.
"""
import datetime
import hashlib
import http.client
import json
import os
import pathlib
import stat
import re
import selectors
import signal
import socket
import subprocess
import time
import io
import tarfile

PROCESS_GROUP_CONTRACT='parent-group-no-escape-v1'

# Current protected configuration supplies instance identity; never reuse historical live bindings.
CONTAINER=IMAGE_ID=NETWORK=HOST=NODE=DOCKER_SHA=None
PORT=3001
IMAGE='ghcr.io/opensourceminers/lightningmate:v0.7.7@sha256:917fa062d9520ea5bf92fb94bbe12b2947ed025c2bd8b82b3dcd5435127392ce'
SOURCES={'/app/server/dist/services/auth.js':'ad4d73bf1c8864df4d65f7170e8ce88c21a6decf7a879891091c21481a3d1ac9','/app/server/dist/services/autopilot.js':'549a617424be7ef686569e2c5d09f6fe3382c3e3ec3925b800020bf144e90274','/app/server/dist/routes/api.js':'c4f7a86be8e0f9d4a6e81e0b750ba874fb69e91ce770e2c26769256c96bef668','/app/server/dist/store.js':'03e4ef9db1234ad31b3553c91e1b72440b7bc231e9c0700b30436dff400704f5'}
FLAGS={'fee':'enabled','rebalance':'rebalanceEnabled','channel':'channelEnabled','sell':'sellEnabled','autoclose':'sellAutoClose','relist':'sellAutoRelist','reprice':'sellAutoReprice','size':'sellAutoSize','maxHTLC':'maxHtlcEnabled'}
STAGES=(('POST','/api/auth/unlock'),('GET','/api/auth/status'),('GET','/api/autopilot'),('GET','/api/settings'),('GET','/api/lsp/status'))
ENV={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/nonexistent','LANG':'C','LC_ALL':'C'}

class Refusal(Exception):
    def __init__(self,code): self.code=code;super().__init__(code)

def configure(config):
    """Protected loader only: current exact runtime/endpoint; fixed v0.7.7 source semantics."""
    global CONTAINER,IMAGE_ID,NETWORK,HOST,NODE,DOCKER_SHA,PORT
    runtime=config['runtimeBinding']; endpoint=config['endpoint']; generation=config['runtimeGeneration']
    if (config.get('version')!='0.7.7' or config.get('nativeSourceHashes')!=SOURCES
        or set(runtime)!={'containerId','imageRef','imageId'} or runtime['imageRef']!=IMAGE
        or not re.fullmatch('[a-f0-9]{64}',runtime['containerId']) or not re.fullmatch('sha256:[a-f0-9]{64}',runtime['imageId'])
        or set(endpoint)!={'ip','port','networkId'} or endpoint['port']!=3001
        or not re.fullmatch('[a-f0-9]{64}',endpoint['networkId'])
        or not re.fullmatch('(02|03)[a-f0-9]{64}',config.get('expectedLndNodeId',''))
        or not re.fullmatch('[a-f0-9]{64}',config.get('dockerSha256',''))
        or set(generation)!={'startedAt','restartCount'} or type(generation['restartCount']) is not int or generation['restartCount']<0
        or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z',generation['startedAt'])):
        raise Refusal('protected_config')
    import ipaddress
    if not isinstance(ipaddress.ip_address(endpoint['ip']),ipaddress.IPv4Address):raise Refusal('protected_endpoint')
    CONTAINER,IMAGE_ID=runtime['containerId'],runtime['imageId']
    NETWORK,HOST,NODE,DOCKER_SHA=endpoint['networkId'],endpoint['ip'],config['expectedLndNodeId'],config['dockerSha256']

class Budget:
    def __init__(self,clock=time.monotonic,seconds=30):self.clock=clock;self.end=clock()+seconds
    def remaining(self):
        value=self.end-self.clock()
        if value<=0:raise Refusal('deadline')
        return value
    def check(self):self.remaining()

class DeadlineFile(io.RawIOBase):
    def __init__(self,owner):super().__init__();self.owner=owner;owner.files+=1
    def readable(self):return True
    def readinto(self,buffer):
        self.owner.prepare();size=self.owner.raw.recv_into(buffer);self.owner.budget.check();return size
    def close(self):
        if not self.closed:self.owner.files-=1;self.owner.release()
        super().close()

class DeadlineSocket:
    def __init__(self,raw,budget):self.raw=raw;self.budget=budget;self.files=0;self.closed=False
    def prepare(self):self.raw.settimeout(min(3,self.budget.remaining()))
    def sendall(self,value):self.prepare();self.raw.sendall(value);self.budget.check()
    def makefile(self,mode,buffering=None):
        if mode!='rb':raise Refusal('parser')
        return io.BufferedReader(DeadlineFile(self))
    def close(self):self.closed=True;self.release()
    def release(self):
        if self.closed and not self.files:self.raw.close()

class Connection(http.client.HTTPConnection):
    def __init__(self,budget):super().__init__(HOST,PORT,timeout=min(3,budget.remaining()));self.budget=budget
    def connect(self):
        self.sock=DeadlineSocket(socket.create_connection((HOST,PORT),min(3,self.budget.remaining())),self.budget);self.budget.check()

class Http:
    def __init__(self,budget,connection=Connection):self.budget=budget;self.connection=connection;self.index=0;self.closed=False;self.active=None
    def next(self,secret):
        if self.closed or self.index>=len(STAGES):raise Refusal('finite_surface')
        method,path=STAGES[self.index];self.index+=1;self.budget.check();body=bytearray();request_body=None;response=None;conn=None
        try:
            headers={'Accept':'application/json','Connection':'close'}
            if method=='POST':
                request_body=bytearray(json.dumps({'password':secret},separators=(',',':')).encode());headers['Content-Type']='application/json'
            else:headers['Authorization']='Bearer '+secret
            conn=self.connection(self.budget);self.active=conn;conn.request(method,path,body=request_body,headers=headers);headers.clear();response=conn.getresponse()
            if response.status in (401,429):raise Refusal('auth_'+str(response.status))
            if response.status!=200:raise Refusal('http_rejected')
            if response.getheader('Content-Type','').split(';')[0].strip().lower()!='application/json':raise Refusal('content_type')
            length=response.getheader('Content-Length')
            if length is not None and (not re.fullmatch(r'\d{1,9}',length) or int(length)>65536):raise Refusal('body_cap')
            while len(body)<=65536:
                self.budget.check();block=response.read1(min(8192,65537-len(body)))
                if not block:break
                body.extend(block)
            self.budget.check()
            if len(body)>65536:raise Refusal('body_cap')
            value=json.loads(body,parse_constant=lambda _:(_ for _ in ()).throw(Refusal('json')))
            if not isinstance(value,dict):raise Refusal('json')
            return value
        except Refusal:raise
        except Exception:raise Refusal('native_read_unavailable') from None
        finally:
            body[:]=b'\x00'*len(body)
            if request_body is not None:request_body[:]=b'\x00'*len(request_body)
            if response:response.close()
            if conn:conn.close()
            self.active=None
    def close(self):
        self.closed=True
        if self.active:self.active.close()
        self.active=None

def public_source_digest(raw,path):
    """One regular tar entry, bounded payload, canonical zero padding/EOF.

    Parse the first header directly so PAX/GNU extension records cannot hide
    extra entries. Never extract onto a filesystem.
    """
    try:
        if len(raw)>1048576 or len(raw)<1536 or len(raw)%512:
            raise Refusal('source_archive')
        entry=tarfile.TarInfo.frombuf(bytes(raw[:512]),'utf8','strict')
        if (entry.type!=tarfile.REGTYPE or entry.name!=path.rsplit('/',1)[1]
            or entry.linkname or not 0<entry.size<=262144):
            raise Refusal('source_archive')
        end=512+entry.size; padded=512+((entry.size+511)//512)*512
        if len(raw)<padded+1024 or any(raw[end:]):
            raise Refusal('source_archive')
        return hashlib.sha256(memoryview(raw)[512:end]).hexdigest()
    except Refusal:raise
    except Exception:raise Refusal('source_archive') from None


class Docker:
    def __init__(self,budget):self.budget=budget;self.active=None;self.pids=[];self.binary_checked=False;self.generation=None
    def verify_binary(self):
        path=pathlib.Path('/usr/bin/docker');fd=os.open(path,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW)
        try:
            before=os.fstat(fd);cap=64*1048576
            if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_mode&0o022 or before.st_nlink!=1 or before.st_size>cap:raise Refusal('docker_binary')
            hashed=hashlib.sha256();count=0
            while True:
                self.budget.check();block=os.read(fd,min(65536,cap+1-count))
                if not block:break
                count+=len(block)
                if count>cap:raise Refusal('docker_binary')
                hashed.update(block)
            after=os.fstat(fd);selected=path.lstat()
            identity=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns,x.st_mode,x.st_uid,x.st_nlink)
            if identity(before)!=identity(after) or identity(after)!=identity(selected) or hashed.hexdigest()!=DOCKER_SHA:raise Refusal('docker_binary')
            self.budget.check()
        finally:os.close(fd)
    def command(self,args,cap=16384):
        # Nonexistent config path is a deliberately closed read-only selection;
        # inspect/cp only, no Docker configuration save/create operation.
        argv=['/usr/bin/docker','--host=unix:///var/run/docker.sock','--config=/nonexistent/satssurge-reader-config',*args]
        buffers=[bytearray(),bytearray()];child=None
        try:
            self.verify_binary()
            child=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=ENV,start_new_session=False);self.active=child;self.pids.append(child.pid)
            with selectors.DefaultSelector() as selection:
                for index,stream in enumerate([child.stdout,child.stderr]):os.set_blocking(stream.fileno(),False);selection.register(stream,selectors.EVENT_READ,index)
                while selection.get_map():
                    for key,_ in selection.select(min(.05,self.budget.remaining())):
                        block=os.read(key.fileobj.fileno(),min(4096,cap+1-len(buffers[key.data])))
                        if not block:selection.unregister(key.fileobj);continue
                        buffers[key.data].extend(block)
                        if len(buffers[key.data])>cap:raise Refusal('command_cap')
            if child.wait(timeout=min(3,self.budget.remaining())):raise Refusal('command_failed')
            self.budget.check();return bytes(buffers[0])
        except Refusal:raise
        except Exception:raise Refusal('command_unavailable') from None
        finally:
            if child:
                if child.poll() is None:
                    try:child.kill()
                    except ProcessLookupError:pass
                child.wait();child.stdout.close();child.stderr.close()
            for buffer in buffers:buffer[:]=b'\x00'*len(buffer)
            self.active=None
    def binding(self):
        # No password/APP_SEED value is selected before source/runtime checks.
        fmt='{"id":{{json .Id}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}},"network":{{json (index .NetworkSettings.Networks "umbrel_main_network").NetworkID}},"ip":{{json (index .NetworkSettings.Networks "umbrel_main_network").IPAddress}},"version":[{{range .Config.Env}}{{$p := split . "="}}{{if eq (index $p 0) "APP_VERSION"}}{{json (index $p 1)}},{{end}}{{end}}"END"]}'
        self.verify_binary()
        raw=self.command(['inspect','--format',fmt,CONTAINER]);value=json.loads(raw);raw=None
        try:
            generation={'startedAt':value.pop('startedAt',None),'restartCount':value.pop('restartCount',None)}
            if (not isinstance(generation['startedAt'],str)
                or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z',generation['startedAt'])
                or generation['startedAt'].startswith('0001-')
                or type(generation['restartCount']) is not int or generation['restartCount']<0):
                raise Refusal('runtime_generation')
            if self.generation is not None and self.generation!=generation:
                raise Refusal('runtime_generation')
            if value!={'id':CONTAINER,'image':IMAGE,'imageId':IMAGE_ID,'running':True,'restarting':False,'network':NETWORK,'ip':HOST,'version':['v0.7.7','END']}:raise Refusal('runtime_binding')
        finally:value.clear()
        sources={}
        for path,expected in SOURCES.items():
            # Docker archive API reads fixed public files; no process in app,
            # extraction, write, auth/config/cookie path or arbitrary source URI.
            raw=bytearray(self.command(['cp',CONTAINER+':'+path,'-'],cap=1048576))
            try:
                sources[path]=public_source_digest(raw,path)
                if sources[path]!=expected:raise Refusal('source_binding')
            except Refusal:raise
            except Exception:raise Refusal('source_archive') from None
            finally:raw[:]=b'\x00'*len(raw)
            self.budget.check()
        if sources!=SOURCES:raise Refusal('source_binding')
        sources.clear()
        self.verify_binary();self.budget.check()
        if self.generation is None:self.generation=generation
    def password(self):
        fmt='{{range .Config.Env}}{{$p := split . "="}}{{if eq (index $p 0) "APP_PASSWORD"}}{{json .}}{{println}}{{end}}{{end}}'
        raw=bytearray(self.command(['inspect','--format',fmt,CONTAINER],cap=8192))
        try:
            try:value=json.loads(raw.decode('utf8'))
            except (ValueError,UnicodeError):raise Refusal('configured_reference') from None
            if not isinstance(value,str) or not value.startswith('APP_PASSWORD='):raise Refusal('configured_reference')
            password=value.split('=',1)[1].strip();value=None
            if not password or len(password)>4096:raise Refusal('configured_reference')
            return password
        finally:raw[:]=b'\x00'*len(raw)
    def close(self):
        if self.active:
            if self.active.poll() is None:
                try:self.active.kill()
                except ProcessLookupError:pass
            self.active.wait();self.active=None

class Reader:
    def __init__(self,native,http,budget):self.native=native;self.http=http;self.budget=budget;self.used=False
    def run(self):
        if self.used:raise Refusal('already_attempted')
        self.used=True;password=token=None;objects=[];facts={}
        try:
            self.native.binding();self.budget.check();password=self.native.password();self.budget.check()
            def exchange(secret):
                self.budget.check()
                value=self.http.next(secret)
                try:self.budget.check()
                except BaseException:value.clear();raise
                return value
            def session_valid():
                match=re.fullmatch(r'(\d{13})\.([A-Za-z0-9_-]{43})',token)
                now=time.time()*1000
                if not match or not now<int(match[1])<=now+12*60*60*1000+5000:raise Refusal('session_expiry')
            result=exchange(password);objects.append(result);password=None
            token=result.get('token');result.clear();objects.clear()
            if not isinstance(token,str) or len(token)>8192:raise Refusal('session')
            session_valid()
            self.native.binding()
            session_valid();result=exchange(token);objects.append(result)
            status=result.get('authRequired') is True and result.get('unlocked') is True;result.clear();objects.clear()
            if not status:raise Refusal('session_status')
            self.native.binding()
            session_valid();result=exchange(token);objects.append(result);config=result.get('config')
            if not isinstance(config,dict):raise Refusal('native_config')
            projected={key:config.get(native) for key,native in FLAGS.items()};result.clear();objects.clear();config=None
            if any(type(v) is not bool for v in projected.values()):raise Refusal('native_flags')
            facts.update(projected);self.native.binding()
            session_valid();result=exchange(token);objects.append(result);lsp=result.get('lspModeEnabled');result.clear();objects.clear()
            if type(lsp) is not bool:raise Refusal('native_flags')
            facts['lsp']=lsp;self.native.binding()
            session_valid();result=exchange(token);objects.append(result);node=result.get('pubkey');result.clear();objects.clear()
            if node!=NODE:raise Refusal('node_binding')
            self.native.binding();self.budget.check();session_valid()
            return {'contract':'satssurge-lm-native-read-v1','version':'0.7.7','sourceHashes':dict(SOURCES),'runtimeBinding':{'containerId':CONTAINER,'imageRef':IMAGE,'imageId':IMAGE_ID},'runtimeGeneration':dict(self.native.generation),'nodeId':node,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'flags':facts}
        except Refusal:raise
        except Exception:raise Refusal('qualification_unavailable') from None
        finally:
            password=token=None
            for value in objects:value.clear()
            self.http.close();self.native.close()

def main():
    budget=Budget(seconds=6);native=Docker(budget);http=Http(budget)
    try:print(json.dumps(Reader(native,http,budget).run(),sort_keys=True))
    except Refusal as e:print(json.dumps({'qualified':False,'reason':e.code}));return 1
    return 0

if __name__=='__main__':raise SystemExit(main())

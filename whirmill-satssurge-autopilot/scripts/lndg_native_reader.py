"""Finite LNDg 1.11.1 native settings/GetInfo read; no initializer or Django setup.

Executed only by the protected hook after actual installed image/source checks.
Uses the source's native TLS configuration and exposes only GetInfo. No credentials,
settings values outside the three exact global keys, or payment rows leave it.
"""
import hashlib
import json
import re

VERSION = '1.11.1'
IMAGE = 'ghcr.io/cryptosharks131/lndg:v1.11.1@sha256:e1589e1d5ec89a4abe59610e808a4c9664dbc84eb66c30d15ffa2dd87232729e'
SOURCES = ('/app/lndg/settings.py', '/app/gui/models.py', '/app/jobs.py', '/app/rebalancer.py', '/app/gui/views.py',
           '/app/gui/lnd_deps/lnd_connect.py', '/app/gui/lnd_deps/lightning_pb2.py',
           '/app/gui/lnd_deps/lightning_pb2_grpc.py')
FLAGS = {'lndgAF': 'AF-Enabled', 'lndgAR': 'AR-Enabled', 'lndgAutopilot': 'AR-Autopilot'}
# Fixed source-side code: private native TLS configuration is never returned.
# The generated source client pins GetInfo's actual wire shape. Deadline/body
# caps are imposed independently of the source's broader normal client limits.
NATIVE_READ = r'''
import os, json, sqlite3, signal, stat
previous=signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(SystemExit(1)))
signal.setitimer(signal.ITIMER_REAL,3)
c=channel=None
try:
 import grpc
 os.environ['PYTHONDONTWRITEBYTECODE']='1'
 from lndg import settings
 from gui.lnd_deps import lightning_pb2 as ln, lightning_pb2_grpc as rpc
 def bounded(path):
  fd=os.open(os.path.expanduser(path),os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW)
  try:
   before=os.fstat(fd)
   if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>65536:raise ValueError('native credential bound')
   raw=bytearray()
   while len(raw)<=65536:
    block=os.read(fd,min(8192,65537-len(raw)))
    if not block:break
    raw.extend(block)
   after=os.fstat(fd)
   identity=lambda x:(x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns,x.st_mode,x.st_nlink)
   if not raw or len(raw)>65536 or identity(before)!=identity(after):raise ValueError('native credential changed')
   return bytes(raw)
  finally:os.close(fd)
 path=settings.DATABASES['default']['NAME']
 if str(path) != '/app/data/db.sqlite3': raise ValueError('native database binding')
 c=sqlite3.connect('file:/app/data/db.sqlite3?mode=ro',uri=True,timeout=1)
 c.execute('PRAGMA query_only=ON'); c.execute('BEGIN')
 rows=c.execute("SELECT key,value FROM gui_localsettings WHERE key IN ('AF-Enabled','AR-Enabled','AR-Autopilot') ORDER BY key LIMIT 4").fetchall()
 if len(rows)!=3 or len(dict(rows))!=3 or any(type(v) is not str or v not in ('0','1') for k,v in rows): raise ValueError('native settings')
 if c.execute('SELECT 1 FROM gui_rebalancer WHERE status IN (0,1) LIMIT 1').fetchone(): raise ValueError('native pending work')
 # Same native TLS settings and gRPC credential construction as pinned lnd_connect.py;
 # credentials stay memory-only and only GetInfo is exposed in this fixed body.
 os.environ['GRPC_SSL_CIPHER_SUITES']='HIGH+ECDSA'
 cert=bounded(settings.LND_TLS_PATH);macaroon=bounded(settings.LND_MACAROON_PATH).hex()
 def metadata_callback(context,callback):callback([('macaroon',macaroon)],None)
 creds=grpc.composite_channel_credentials(grpc.ssl_channel_credentials(cert),grpc.metadata_call_credentials(metadata_callback))
 channel=grpc.secure_channel(settings.LND_RPC_SERVER,creds,options=[('grpc.enable_retries',0),('grpc.max_send_message_length',65536),('grpc.max_receive_message_length',65536)])
 info=rpc.LightningStub(channel).GetInfo(ln.GetInfoRequest(),timeout=2)
 node=info.identity_pubkey
 rows2=c.execute("SELECT key,value FROM gui_localsettings WHERE key IN ('AF-Enabled','AR-Enabled','AR-Autopilot') ORDER BY key LIMIT 4").fetchall()
 if rows2!=rows: raise ValueError('native settings changed')
 print(json.dumps({'nodeId':node,'settings':dict(rows)},sort_keys=True,separators=(',',':')))
finally:
 if channel is not None:channel.close()
 if c is not None:c.close()
 signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,previous)
'''


def project(value, expected_node):
    if not isinstance(value, dict) or set(value) != {'nodeId', 'settings'}:
        raise ValueError('Native LNDg shape unavailable')
    if not re.fullmatch(r'(02|03)[a-f0-9]{64}', value.get('nodeId', '')) or value['nodeId'] != expected_node:
        raise ValueError('Native LNDg node binding unavailable')
    settings = value['settings']
    if not isinstance(settings, dict) or set(settings) != set(FLAGS.values()) or any(type(v) is not str or v not in ('0', '1') for v in settings.values()):
        raise ValueError('Native LNDg settings unavailable')
    flags = {key: settings[native] == '1' for key, native in FLAGS.items()}
    if any(flags.values()): raise ValueError('Native LNDg automation enabled')
    return {'nodeId': value['nodeId'], 'flags': flags}


def acquire(config, native):
    """The protected native-hook supplies the bounded Docker archive/exec reader."""
    if config['version'] != VERSION or config['runtimeBinding']['imageRef'] != IMAGE or set(config['nativeSourceHashes']) != set(SOURCES):
        raise ValueError('Unsupported native LNDg version/source scope')
    native.binding()
    first = project(json.loads(native.command(['exec', '--env', 'PYTHONDONTWRITEBYTECODE=1', config['runtimeBinding']['containerId'], 'python3', '-B', '-c', NATIVE_READ], cap=16384)), config['expectedLndNodeId'])
    native.binding()
    second = project(json.loads(native.command(['exec', '--env', 'PYTHONDONTWRITEBYTECODE=1', config['runtimeBinding']['containerId'], 'python3', '-B', '-c', NATIVE_READ], cap=16384)), config['expectedLndNodeId'])
    native.binding()
    if first != second: raise ValueError('Native LNDg settings/node changed')
    evidence = {**first, 'version': VERSION, 'sourceHashes': config['nativeSourceHashes'], 'runtimeBinding': config['runtimeBinding'], 'runtimeGeneration': config['runtimeGeneration']}
    return {**first, 'settingsDigest': hashlib.sha256(json.dumps(evidence, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}

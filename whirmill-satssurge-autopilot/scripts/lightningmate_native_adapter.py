"""Local hook acquisition candidate. Protected loader and native review pending.

The pinned reader is the unique auth/getter/validator implementation, not copied here.
No receipt file or caller-provided native snapshot is an acquisition interface.
"""
import datetime as dt
import hashlib
import json
import re

READER_SHA='7466315027082cf3f4ba94aa3eb09c64e478c5280d49714c84d5a410d922f2fb'
HOOK_CONTRACT='satssurge-native-host-hook-v1'
FLAGS=('fee','rebalance','channel','sell','autoclose','relist','reprice','size','maxHTLC','lsp')
NATIVE_KEYS={'contract','version','sourceHashes','runtimeBinding','runtimeGeneration','nodeId','at','flags'}
HOOK_KEYS={'contract','sourceHash','scope','at','hostBootId','generation','complete','nodeId','flags','settingsDigest'}
OWNERSHIP='parent-group-no-escape-v1'
ACQUISITION_SECONDS=6
OUTPUT_CAP=16384

class Refusal(Exception):pass

def encode(payload):
    if set(payload)!=HOOK_KEYS:raise Refusal('closed_hook_schema')
    body=json.dumps(payload,sort_keys=True,separators=(',',':')).encode()
    if len(body)>=OUTPUT_CAP:raise Refusal('output_cap')
    return body

def project(native,config,*,started,finished,elapsed):
    """Pure fixture interface; live acquisition obtains native only from Reader.run."""
    if set(native)!=NATIVE_KEYS or native['contract']!='satssurge-lm-native-read-v1' or native['version']!='0.7.7':raise Refusal('native_schema')
    if config['readerSha256']!=READER_SHA or native['sourceHashes']!=config['nativeSourceHashes']:raise Refusal('source_provenance')
    if native['runtimeBinding']!=config['runtimeBinding'] or native['runtimeGeneration']!=config['runtimeGeneration']:raise Refusal('runtime_generation_provenance')
    if native['nodeId']!=config['expectedLndNodeId']:raise Refusal('node_provenance')
    if set(native['flags'])!=set(FLAGS) or any(native['flags'][flag] is not False for flag in FLAGS):raise Refusal('automation_unknown_or_enabled')
    acquired=dt.datetime.fromisoformat(native['at'].replace('Z','+00:00'))
    if not 0<=elapsed<=ACQUISITION_SECONDS or not started<=acquired<=finished or not 0<=(finished-acquired).total_seconds()<=8:raise Refusal('fresh_acquisition')
    if not re.fullmatch('[a-f0-9]{64}',config['hookSourceHash']) or type(config['generation']) is not int or config['generation']<0:raise Refusal('hook_provenance')
    # Hash only this already-sanitized native projection, never raw response bodies.
    evidence={key:native[key] for key in ('version','sourceHashes','runtimeBinding','runtimeGeneration','nodeId','flags')}
    settings_digest=hashlib.sha256(json.dumps(evidence,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    payload={'contract':HOOK_CONTRACT,'sourceHash':config['hookSourceHash'],'scope':'lightningmate','at':native['at'],'hostBootId':config['hostBootId'],'generation':config['generation'],'complete':True,'nodeId':native['nodeId'],'flags':{flag:False for flag in FLAGS},'settingsDigest':settings_digest}
    encode(payload)
    return payload

def acquire(reader,config,*,reader_file_sha256,wall,monotonic):
    """Future protected root loader supplies pinned module/config and clocks.

    A protected loader must verify the module bytes before loading. Changing a
    config field cannot qualify a missing executable ownership contract.
    """
    if reader_file_sha256!=READER_SHA or config['readerSha256']!=READER_SHA:raise Refusal('reader_source')
    if getattr(reader,'PROCESS_GROUP_CONTRACT',None)!=OWNERSHIP:raise Refusal('reader_process_ownership_unqualified')
    started=wall();tick=monotonic();budget=reader.Budget(clock=monotonic,seconds=ACQUISITION_SECONDS)
    reader.configure(config)
    native=reader.Docker(budget);native.generation=dict(config['runtimeGeneration']);http=reader.Http(budget)
    try:
        value=reader.Reader(native,http,budget).run()
        budget.check()
        return project(value,config,started=started,finished=wall(),elapsed=monotonic()-tick)
    finally:
        http.close();native.close()

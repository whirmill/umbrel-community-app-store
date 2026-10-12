"""Sanitized four-app controls. No owner-wide inventory or financial permission."""
import hashlib,json,re
IDS=['lightningmate','lndg','lightning-terminal','albyhub']
PUBLIC_KEYS=['schema','scope','hostBootId','generation','sourceHash','producerHash','runtimeBinding','expectedLndNodeId','appIds','installedQualifications','albyQualification']
HASH=re.compile(r'[a-f0-9]{64}')
NODE=re.compile(r'(02|03)[a-f0-9]{64}')
def digest(v):return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def binding(v):
 if not isinstance(v,dict) or not HASH.fullmatch(v.get('containerId','')) or not re.fullmatch(r'[a-z0-9./:_-]+@sha256:[a-f0-9]{64}',v.get('imageRef','')) or not re.fullmatch(r'sha256:[a-f0-9]{64}',v.get('imageId','')):raise ValueError('binding')
 return {k:v[k] for k in ['containerId','imageRef','imageId']}
def public_contract(c):
 if c.get('schema')!=1 or type(c['schema']) is not int or c.get('scope')!='apps-only' or c.get('appIds')!=IDS or type(c.get('generation')) is not int or not 0<=c['generation']<=9007199254740991 or not NODE.fullmatch(c.get('expectedLndNodeId','')) or not re.fullmatch(r'[a-f0-9-]{36}',c.get('hostBootId','')) or not HASH.fullmatch(c.get('sourceHash','')) or not HASH.fullmatch(c.get('producerHash','')):raise ValueError('contract')
 result={k:c[k] for k in ['schema','scope','hostBootId','generation','sourceHash','producerHash','expectedLndNodeId','appIds']};result['runtimeBinding']=binding(c['runtimeBinding']);result['installedQualifications']={}
 for app,q in c.get('installedQualifications',{}).items():
  if app not in IDS:raise ValueError('app_scope')
  row={'runtimeBinding':binding(q['runtimeBinding'])}
  if app!='albyhub':
   if not isinstance(q['version'],str) or not re.fullmatch(r'[a-zA-Z0-9.+_-]{1,64}',q['version']):raise ValueError('version')
   row['version']=q['version']
  if app!='albyhub':
   if not HASH.fullmatch(q['hook'].get('sourceHash','')):raise ValueError('hook')
   row['hook']={'sourceHash':q['hook']['sourceHash']}
  result['installedQualifications'][app]=row
 if 'albyQualification' in c:
  q=c['albyQualification']
  if q.get('contract')!='albyhub-v1.24.0-native-read-v1' or q.get('version')!='1.24.0-patch.1' or not HASH.fullmatch(q.get('sourceHash','')):raise ValueError('alby')
  result['albyQualification']={k:q[k] for k in ['contract','version','sourceHash']}
 return result

def qualification(app,facts,c):
 expected=c.get('installedQualifications',{}).get(app)
 if not expected or facts.get('runtimeBinding')!=expected.get('runtimeBinding'):raise ValueError('runtime')
 if app=='albyhub':
  b=facts['backendFacts'];e=c.get('albyQualification',{})
  if b.get('contract')!=e.get('contract') or b.get('version')!=e.get('version') or b.get('sourceHash')!=e.get('sourceHash') or not NODE.fullmatch(b.get('nodeId','')) or type(b.get('autoSwapOutEnabled')) is not bool or not (b.get('backend')=='lnd' and (b['nodeId']!=c['expectedLndNodeId'] or b['autoSwapOutEnabled'] is False) or b.get('backend')=='ldk' and b['nodeId']!=c['expectedLndNodeId']):raise ValueError('backend')
  return {**{k:b[k] for k in ['contract','version','sourceHash','nodeId','backend','autoSwapOutEnabled']},'runtimeBinding':facts['runtimeBinding']}
 keys=['fee','rebalance','channel','sell','autoclose','relist','reprice','size','maxHTLC','lsp'] if app=='lightningmate' else ['lndgAF','lndgAR','lndgAutopilot'] if app=='lndg' else ['loop']
 if facts.get('nodeId')!=c['expectedLndNodeId'] or facts.get('version')!=expected.get('version') or facts.get('sourceHash')!=expected.get('hook',{}).get('sourceHash') or not HASH.fullmatch(facts.get('settingsDigest','')) or any(facts.get('flags',{}).get(k) is not False for k in keys):raise ValueError('settings')
 return {**{k:facts[k] for k in ['runtimeBinding','version','sourceHash','settingsDigest','nodeId']},'flags':dict.fromkeys(keys,False)}
def unknown(app):return {'id':app,'durableInstalled':None,'lifecycle':'unknown','containers':[],'qualification':None}

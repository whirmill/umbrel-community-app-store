#!/usr/bin/env python3
"""Host read-only watcher. Atomic projection only; no config changes or credentials output."""
import datetime,json,os,pathlib,sqlite3,subprocess,sys
root=pathlib.Path(sys.argv[1]); output=root/'interlock/status.json'
base=pathlib.Path('/home/umbrel/umbrel/app-data')
status={'schema':1,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
try:
    c=json.loads((base/'lightningmate/data/autopilot.json').read_text())['config']
    mapping={'fee':'enabled','rebalance':'rebalanceEnabled','channel':'channelEnabled','sell':'sellEnabled','autoclose':'sellAutoClose','relist':'sellAutoRelist','reprice':'sellAutoReprice','size':'sellAutoSize','maxHTLC':'maxHtlcEnabled'}
    for key,field in mapping.items(): status[key]=c[field] if type(c[field]) is bool else None
    # Inspect LSP mode in current runtime's dedicated configuration endpoint/setting.
    settings_path=base/'lightningmate/data/settings.json'
    if settings_path.exists(): status['lsp']=json.loads(settings_path.read_text()).get('lspModeEnabled',None)
    else:
        code=subprocess.run(['docker','exec','lightningmate_web_1','sha256sum','/app/server/dist/services/settings.js'],check=True,capture_output=True,text=True).stdout.split()[0]
        status['lsp']=False if code=='c3afaacca8ca09bdb47adfd97dc976f44cb677ea3d2496511fc0a942aff02373' else None
    db=sqlite3.connect(f'file:{base}/lndg/data/db/db.sqlite3?mode=ro',uri=True)
    values=dict(db.execute('SELECT key,value FROM gui_localsettings WHERE key IN ("AF-Enabled","AR-Enabled","AR-Autopilot")'))
    for key,field in [('lndgAF','AF-Enabled'),('lndgAR','AR-Enabled'),('lndgAutopilot','AR-Autopilot')]:status[key]=False if values.get(field)=='0' else True if values.get(field)=='1' else None
    names=subprocess.run(['docker','ps','--format','{{.Names}}'],check=True,capture_output=True,text=True).stdout.splitlines()
    # No Loop process/container is current proof of no autoloop. Presence needs an adapter.
    status['loop']=False if not any('loop' in n.lower() or 'terminal' in n.lower() or n.startswith('lit_') for n in names) else None
except Exception: status['error']='Live automation format/read mismatch'
output.parent.mkdir(parents=True,exist_ok=True);temp=output.with_suffix('.tmp');temp.write_text(json.dumps(status));os.chmod(temp,0o600);temp.replace(output)

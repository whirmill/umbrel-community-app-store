import copy
import datetime as dt
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(pathlib.Path(__file__).parents[1]))
import host_qualification
import standalone_automation_audit as audit

AT=dt.datetime(2026,10,10,tzinfo=dt.timezone.utc)


class HookTests(unittest.TestCase):
    def fixture(self,scope):
        sha=hashlib.sha256(b'fixture').hexdigest()
        spec={'contract':'satssurge-native-host-hook-v1','path':'/root/hook.py','sourceHash':sha,'python':'/usr/bin/python3','pythonHash':sha,'config':'/root/config.json','configHash':sha}
        contract={'hostBootId':'boot','generation':4,'expectedLndNodeId':'02'+'1'*64}
        body={'contract':spec['contract'],'sourceHash':sha,'scope':scope,'at':AT.isoformat(),'hostBootId':'boot','generation':4,'complete':True,'nodeId':contract['expectedLndNodeId'],'flags':dict.fromkeys(['fee','rebalance','channel','sell','autoclose','relist','reprice','size','maxHTLC','lsp','lndgAF','lndgAR','lndgAutopilot','loop'],False),'settingsDigest':'a'*64,'unqualifiedAutomation':[],'processInventoryDigest':'b'*64,'scheduleInventoryDigest':'c'*64}
        return spec,contract,body

    def test_fixed_isolated_hook_argv_and_actual_acquisition_only(self):
        for scope in ['standalone','lightningmate','lndg','lightning-terminal']:
            spec,contract,body=self.fixture(scope);calls=[]
            def run(argv,**kwargs): calls.append(argv);return json.dumps(body)
            with patch.object(host_qualification.host_read_boundary,'read_bytes',return_value=b'fixture'):
                result=host_qualification.run_hook(spec,scope,contract,run,lambda:AT)
            self.assertEqual(calls,[[spec['python'],'-I','-S',spec['path'],'--config',spec['config'],'--scope',scope]])
            self.assertNotIn('complete',result)

    def test_changed_source_config_stale_incomplete_enabled_or_wrong_node_block(self):
        for modify in [lambda b:b.update(complete=False),lambda b:b.update(nodeId='03'+'2'*64),lambda b:b['flags'].update(fee=True),lambda b:b.update(at=(AT-dt.timedelta(seconds=16)).isoformat()),lambda b:b.update(generation=3),lambda b:b.update(sourceHash='d'*64)]:
            spec,contract,body=self.fixture('lightningmate');modify(body)
            with patch.object(host_qualification.host_read_boundary,'read_bytes',return_value=b'fixture'):
                with self.assertRaises(ValueError): host_qualification.run_hook(spec,'lightningmate',contract,lambda *a,**k:json.dumps(body),lambda:AT)
        spec,contract,body=self.fixture('standalone')
        with patch.object(host_qualification.host_read_boundary,'read_bytes',return_value=b'changed'):
            with self.assertRaises(ValueError): host_qualification.run_hook(spec,'standalone',contract,lambda *a,**k:self.fail('No child after mismatch'),lambda:AT)


class AuditTests(unittest.TestCase):
    def fixture(self,root):
        proc=root/'proc';(proc/'123').mkdir(parents=True);(proc/'123/cmdline').write_bytes(b'qualified-readonly\0');(proc/'123/comm').write_text('fixture')
        binary=root/'qualified-binary';binary.write_bytes(b'qualified-code');(proc/'123/exe').symlink_to(binary)
        schedules=root/'systemd';schedules.mkdir();(schedules/'fixture.service').write_bytes(b'[Service]\nExecStart=/reviewed/readonly\n')
        config={'scope':'linux-proc-and-system-user-schedules-v1','processCommandDigests':[audit.sha(b'qualified-readonly\0')],'processExecutableDigests':{audit.sha(b'qualified-readonly\0'):audit.sha(b'qualified-code')},'scheduleDigests':{str(schedules/'fixture.service'):audit.sha((schedules/'fixture.service').read_bytes())},'indirectSourceDigests':{}}
        return proc,schedules,config

    def test_actual_fixture_inventory_and_unknown_process_or_schedule_refuse(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder).resolve();proc,schedules,config=self.fixture(root)
            result=audit.audit(config,proc,[schedules]);self.assertEqual(result['unqualifiedAutomation'],[])
            self.assertNotIn('qualified-readonly',json.dumps(result))
            (proc/'123/cmdline').write_bytes(b'unreviewed-financial\0')
            with self.assertRaises(ValueError):audit.audit(config,proc,[schedules])
            (proc/'123/cmdline').write_bytes(b'qualified-readonly\0');(schedules/'new.timer').write_text('[Timer]')
            with self.assertRaises(ValueError):audit.audit(config,proc,[schedules])

    def test_schedule_alias_requires_qualified_target_and_indirect_source(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder).resolve();proc,schedules,config=self.fixture(root)
            outside=root/'source.service';outside.write_text('reviewed-source')
            alias=schedules/'alias.service';alias.symlink_to(outside)
            config['scheduleDigests'][str(alias)]=audit.sha(('alias:'+str(outside)).encode())
            with self.assertRaises(ValueError):audit.audit(config,proc,[schedules])
            config['indirectSourceDigests'][str(outside)]=audit.sha(outside.read_bytes())
            self.assertEqual(audit.audit(config,proc,[schedules])['unqualifiedAutomation'],[])
            outside.write_text('changed-source')
            with self.assertRaises(ValueError):audit.audit(config,proc,[schedules])

    def test_unreadable_symlink_fifo_missing_scope_and_deadline_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder).resolve();proc,schedules,config=self.fixture(root)
            linked=root/'alias-root';linked.symlink_to(schedules)
            with self.assertRaises(OSError):audit.audit(config,proc,[linked])
            ticks=iter([0,9])
            with self.assertRaises(ValueError):audit.audit(config,proc,[schedules],clock=lambda:next(ticks))


    def test_unchanged_command_does_not_accept_changed_executable(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder).resolve();proc,schedules,config=self.fixture(root)
            (root/'qualified-binary').write_bytes(b'unreviewed-code')
            with self.assertRaisesRegex(ValueError,'source changed'):audit.audit(config,proc,[schedules])

    def test_empty_user_command_cannot_impersonate_kernel(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder).resolve();proc,schedules,config=self.fixture(root)
            (proc/'123/cmdline').write_bytes(b'')
            fingerprint=audit.sha(b'kernel:fixture')
            config['processCommandDigests']=[fingerprint];config['processExecutableDigests']={fingerprint:'kernel'}
            with self.assertRaises(ValueError):audit.audit(config,proc,[schedules])

    def test_explicit_absent_scope_requires_real_absence_and_reappearing_scope_blocks(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder).resolve();proc,schedules,config=self.fixture(root)
            absent=root/'missing-parent'/'missing-scope'
            config['absentScheduleRoots']=[str(absent)]
            self.assertEqual(audit.audit(config,proc,[schedules,absent])['unqualifiedAutomation'],[])
            absent.mkdir(parents=True)
            with self.assertRaises(ValueError):audit.audit(config,proc,[schedules,absent])

    def test_last_indirect_read_cannot_finish_after_deadline(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder).resolve();proc,schedules,config=self.fixture(root)
            source=root/'indirect';source.write_bytes(b'qualified-source')
            config['indirectSourceDigests'][str(source)]=audit.sha(source.read_bytes())
            ticks=[0];read=audit.host_read_boundary.read_bytes
            def slow_read(path,*args,**kwargs):
                result=read(path,*args,**kwargs)
                if path==source: ticks[0]=9
                return result
            with patch.object(audit.host_read_boundary,'read_bytes',side_effect=slow_read):
                with self.assertRaisesRegex(ValueError,'Audit deadline'):
                    audit.audit(config,proc,[schedules],clock=lambda:ticks[0])

    def test_final_inventory_work_cannot_pass_expired_deadline(self):
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder).resolve();proc,schedules,config=self.fixture(root)
            ticks=[0];names=audit.bounded_names
            def slow_names(directory,*args,**kwargs):
                result=names(directory,*args,**kwargs)
                if isinstance(directory,int): ticks[0]=9
                return result
            with patch.object(audit,'bounded_names',side_effect=slow_names):
                with self.assertRaisesRegex(ValueError,'Audit deadline'):
                    audit.audit(config,proc,[schedules],clock=lambda:ticks[0])

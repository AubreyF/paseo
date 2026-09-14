import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid
from https_broker import Broker, atomic, safe_read, validate


class Fake:
    def __init__(self):
        self.config = {'TCP': {'44443': {'HTTPS': True}}, 'Web': {'test.example.ts.net:44443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:39000'}}}}}
        self.entry = dict(workspaceId='wks_test', service='preview', cwd='/approved', fingerprint='one', type='service', lifecycle='running', terminalId='one', port=33487)
        self.sets = 0
        self.starts = 0
        self.free_calls = []
        self.fail_verify = False
    def preflight(self): pass
    def registered_ports(self): return {33487,39000}
    def current(self, w, s):
        if w != 'wks_test' or s != 'preview': raise ValueError('Unknown service')
        return copy.deepcopy(self.entry)
    def publication(self):
        if any(self.config.get('AllowFunnel', {}).values()): raise ValueError('Unexpected Funnel')
        return copy.deepcopy(self.config)
    def free(self, p): self.free_calls.append(p)
    def backend_ready(self, p): pass
    def listener_identity(self, p, terminal): return terminal
    def lifecycle(self, op, e):
        self.entry['lifecycle'] = 'running' if op == 'start' else 'stopped'
        if op == 'start': self.starts += 1; self.entry['terminalId'] = str(self.starts)
    def set_mapping(self, p, b):
        self.sets += 1
        self.config['TCP'][str(p)] = {'HTTPS': True}
        self.config['Web'][f'test.example.ts.net:{p}'] = {'Handlers': {'/': {'Proxy': f'http://127.0.0.1:{b}'}}}
    def remove_mapping(self, p):
        self.config['TCP'].pop(str(p), None); self.config['Web'].pop(f'test.example.ts.net:{p}', None)
    def verify(self, url):
        if self.fail_verify: raise subprocess.CalledProcessError(1, 'verify')


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        channel = self.root / 'channel'
        for n in ['', 'inbox', 'receipts', 'origins']: (channel/n).mkdir(exist_ok=True)
        self.c = {'deployment': str(self.root), 'channel': str(channel), 'hostname': 'test.example.ts.net', 'reservedPorts': [443,6767,44443], 'portStart':44444,'portEnd':44449, 'channelIdentities':{n:[(channel/n).stat().st_dev,(channel/n).stat().st_ino] for n in ['', 'inbox','receipts','origins']}}
        self.runtime = Fake(); self.b = Broker(self.c,self.runtime)
    def request(self, operation='start', **kw):
        return dict(id=str(uuid.uuid4()), operation=operation, workspaceId='wks_test',service='preview',createdAt=time.time(),**kw)
    def test_repeat_adopts_without_bind_or_set_again(self):
        one=self.b.handle(self.request()); calls=len(self.runtime.free_calls)
        two=self.b.handle(self.request()); self.assertEqual(one,two)
        self.assertEqual(self.runtime.sets,1);self.assertEqual(len(self.runtime.free_calls),calls)
    def test_reserved_and_other_route_preserved(self):
        before=copy.deepcopy(self.runtime.config)
        with self.assertRaises(ValueError):self.b.handle(self.request(preferredPort=44443))
        self.assertEqual(before,self.runtime.config)
    def test_funnel_preflight_no_mutation(self):
        self.runtime.config['AllowFunnel']={'host':True}
        with self.assertRaises(ValueError):self.b.handle(self.request())
        self.assertEqual(self.runtime.sets,0)
    def test_stop_rejects_queued_start_and_recovery(self):
        self.b.handle(self.request());queued=self.request();self.b.handle(self.request('stop'))
        with self.assertRaises(ValueError):self.b.handle(queued)
        self.b.reconcile();self.assertEqual(self.runtime.starts,0);self.assertNotIn('44444',self.runtime.config['TCP'])
        self.assertEqual(self.b.handle(self.request())['frontendPort'],44444)
    def test_backend_reuse_fails_closed(self):
        self.b.handle(self.request());self.runtime.entry['terminalId']='different-process'
        self.b.reconcile();self.assertNotIn('44444',self.runtime.config['TCP']);self.assertEqual(self.runtime.starts,0)
    def test_configuration_change_recovery_does_not_start(self):
        self.b.handle(self.request());self.runtime.entry['fingerprint']='changed'
        self.b.reconcile();self.assertEqual(self.runtime.starts,0);self.assertNotIn('44444',self.runtime.config['TCP'])
    def test_unknown_arbitrary_and_expired(self):
        for modify in [dict(service='other'),dict(url='http://evil'),dict(createdAt=time.time()-200),dict(preferredPort=6767),dict(workspaceId='../evil')]:
            r=self.request();r.update(modify)
            with self.assertRaises(ValueError):self.b.handle(r)
        self.assertEqual(self.runtime.sets,0)
    def test_failed_verification_removes_mapping(self):
        self.runtime.fail_verify=True
        self.assertEqual(self.b.handle(self.request())['status'],'pending')
        self.assertNotIn('44444',self.runtime.config['TCP'])
    def test_external_conflict_never_removed(self):
        self.b.handle(self.request());self.runtime.config['Web']['test.example.ts.net:44444']['Handlers']['/']['Proxy']='http://127.0.0.1:55555'
        with self.assertRaises(ValueError):self.b.handle(self.request('stop'))
        self.assertIn('44444',self.runtime.config['TCP'])
    def test_symlink_and_oversize(self):
        outside=self.root/'protected';outside.write_text('{}');p=self.root/'link';p.symlink_to(outside)
        with self.assertRaises(OSError):safe_read(p)
        p.unlink();p.write_text('x'*5000)
        with self.assertRaises(ValueError):safe_read(p,4096)
        directory=self.root/'dirlink';directory.symlink_to(self.root/'channel',target_is_directory=True)
        with self.assertRaises(OSError):atomic(directory/'bad',{})
    def test_queue_dedup_stop_priority_and_receipts(self):
        self.b.handle(self.request());start=self.request();stop=self.request('stop')
        for r in [start,stop]:atomic(Path(self.c['channel'])/'inbox'/(r['id']+'.json'),r)
        self.b.run();self.assertEqual(self.runtime.starts,0)
        receipt=safe_read(Path(self.c['channel'])/'receipts'/(start['id']+'.json'));self.assertEqual(receipt['status'],'failed')
        atomic(Path(self.c['channel'])/'inbox'/(start['id']+'.json'),start);self.b.run();self.assertEqual(self.runtime.starts,0)
    def test_replaced_channel_rejected(self):
        p=Path(self.c['channel'])/'inbox';p.rename(p.with_name('old'));p.mkdir()
        with self.assertRaises(ValueError):self.b.run()
    def test_occupied_frontend(self):
        def occupied(p):raise subprocess.CalledProcessError(1,'bind')
        self.runtime.free=occupied
        with self.assertRaises(ValueError):self.b.handle(self.request())
        self.assertEqual(self.runtime.sets,0)
    def test_control_plane_backend(self):
        self.runtime.entry['port']=6767
        with self.assertRaises(ValueError):self.b.handle(self.request())
        self.assertEqual(self.runtime.sets,0)

    def test_concurrent_consumer_lock_and_multiple_starts(self):
        import fcntl
        r1=self.request();r2=self.request()
        for r in [r1,r2]:atomic(Path(self.c['channel'])/'inbox'/(r['id']+'.json'),r)
        with (self.root/'https-broker.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):Broker(self.c,self.runtime).run()
        self.b.run();self.assertEqual(self.runtime.sets,1)
    def test_malicious_receipt_symlink_does_not_overwrite_target(self):
        r=self.request();target=self.root/'protected';target.write_text('unchanged')
        receipt=Path(self.c['channel'])/'receipts'/(r['id']+'.json');receipt.symlink_to(target)
        atomic(Path(self.c['channel'])/'inbox'/(r['id']+'.json'),r)
        self.b.run();self.assertEqual(target.read_text(),'unchanged');self.assertFalse(receipt.is_symlink())
    def test_listener_reuse_same_terminal_is_rejected(self):
        self.b.handle(self.request());self.runtime.listener_identity=lambda p,t:'other-listener'
        self.b.reconcile();self.assertNotIn('44444',self.runtime.config['TCP'])
    def test_recovery_adopts_same_process_without_new_mapping(self):
        self.b.handle(self.request());Broker(self.c,self.runtime).reconcile()
        self.assertEqual(self.runtime.sets,1);self.assertEqual(self.runtime.starts,0)

    def test_two_queued_services_receive_distinct_stable_ports(self):
        original=self.runtime.current
        def current(w,s):
            if w=='wks_other':
                entry=original('wks_test',s);entry.update(workspaceId=w,port=33488,terminalId='two');return entry
            return original(w,s)
        self.runtime.current=current
        r1=self.request();r2=self.request();r2['workspaceId']='wks_other'
        for r in [r1,r2]:atomic(Path(self.c['channel'])/'inbox'/(r['id']+'.json'),r)
        self.b.run()
        fronts=[e['frontend'] for e in self.b.ledger['entries'].values()]
        self.assertEqual(sorted(fronts),[44444,44445])

    def test_changed_live_configuration_requires_restart(self):
        self.b.handle(self.request());self.runtime.entry['fingerprint']='changed'
        with self.assertRaises(ValueError):self.b.handle(self.request())
        self.assertNotIn('44444',self.runtime.config['TCP'])

if __name__=='__main__':unittest.main()

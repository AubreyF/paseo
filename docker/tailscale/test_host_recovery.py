import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('host-recovery.py'))
recovery = importlib.util.module_from_spec(spec)
with patch.dict(os.environ, {'PASEO_DEPLOYMENT_DIR': '/tmp/paseo-recovery-test', 'PASEO_CONTAINER_NAME': 'test-paseo', 'PASEO_ROLLBACK_CONTAINER_NAME': 'test-rollback'}):
    spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        recovery.ROOT = Path(self.temp.name)
        recovery.PAUSED = recovery.ROOT / 'paused'
        recovery.STATE = recovery.ROOT / 'status.json'
        self.argv = patch.object(recovery.sys, 'argv', ['host-recovery.py'])
        self.argv.start()
        self.addCleanup(self.argv.stop)

    def test_pause_never_touches_docker(self):
        recovery.PAUSED.touch()
        with patch.object(recovery, 'docker') as docker:
            recovery.main()
        docker.assert_not_called()

    def test_rollback_never_starts_replacement(self):
        with patch.object(recovery, 'docker', side_effect=[subprocess.CompletedProcess([], 0, '24'), subprocess.CompletedProcess([], 0, 'true')]) as docker:
            recovery.main()
        self.assertEqual(docker.call_count, 2)
        self.assertIn('Rollback', json.loads(recovery.STATE.read_text())['status'])

    def test_healthy_container_only_restores_as_unprivileged_user(self):
        live = {'Id': 'existing', 'State': {'Running': True, 'Health': {'Status': 'healthy'}}}
        results = [subprocess.CompletedProcess([], 0, value) for value in ['24', 'false', json.dumps([live]), '[]']]
        with patch.object(recovery, 'docker', side_effect=results) as docker:
            recovery.main()
        self.assertEqual(docker.call_args.args, ('exec', recovery.CONTAINER, '/usr/bin/setpriv', '--reuid=paseo', '--regid=paseo', '--init-groups', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '/home/paseo/.local/bin/paseo-preview', 'recover'))
        self.assertEqual(json.loads(recovery.STATE.read_text())['status'], 'Healthy')

    def test_unhealthy_container_is_not_restarted(self):
        live = {'State': {'Running': True, 'Health': {'Status': 'unhealthy'}}}
        results = [subprocess.CompletedProcess([], 0, value) for value in ['24', 'false', json.dumps([live])]]
        with patch.object(recovery, 'docker', side_effect=results) as docker:
            recovery.main()
        self.assertEqual(docker.call_count, 3)
        self.assertIn('no forced restart', json.loads(recovery.STATE.read_text())['status'])

    def test_docker_start_retries_are_bounded(self):
        recovery.STATE.write_text(json.dumps({'dockerStartAttempts': 3}))
        with patch.object(recovery, 'docker', side_effect=subprocess.TimeoutExpired('docker', 10)), patch.object(recovery.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)), patch.object(recovery, 'command') as command:
            recovery.main()
        command.assert_not_called()
        self.assertEqual(json.loads(recovery.STATE.read_text())['dockerStartAttempts'], 3)

    def test_existing_stopped_container_is_started_without_recreation(self):
        results = [subprocess.CompletedProcess([], 0, value) for value in ['24', 'false', json.dumps([{'State': {'Running': False}}]), 'started']]
        with patch.object(recovery, 'docker', side_effect=results) as docker:
            recovery.main()
        self.assertEqual(docker.call_args.args, ('start', recovery.CONTAINER))
        self.assertEqual(json.loads(recovery.STATE.read_text())['containerStartAttempts'], 1)


if __name__ == '__main__':
    unittest.main()

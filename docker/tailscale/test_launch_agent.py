import plistlib
from pathlib import Path
import subprocess
import tempfile
import unittest

from launch_agent import install, label_for, remove


class LaunchAgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.jobs = self.root / 'LaunchAgents'
        self.calls = []

    def execute(self, args, **kwargs):
        self.calls.append(args)
        return subprocess.CompletedProcess(args, 0)

    def content(self, root):
        label = label_for('https-preview-broker', root)
        return {'Label': label, 'ProgramArguments': ['/usr/bin/python3', '-I', str(root / 'https_broker.py')]}

    def test_two_installations_and_removal_preserve_other_instance(self):
        first, second = self.root / 'one', self.root / 'two'
        for root in (first, second):
            install(self.content(root), root / 'https_broker.py', [], self.jobs, self.execute)
        first_label, second_label = [self.content(root)['Label'] for root in (first, second)]
        self.assertNotEqual(first_label, second_label)
        remove(first_label, first / 'https_broker.py', self.jobs, self.execute)
        self.assertTrue((self.jobs / (second_label + '.plist')).is_file())
        stopped = [args[-1].split('/')[-1] for args in self.calls if args[1] == 'bootout']
        self.assertEqual(stopped, [first_label])

    def legacy(self, root):
        label = 'local.paseo.https-preview-broker'
        self.jobs.mkdir(exist_ok=True)
        path = self.jobs / (label + '.plist')
        path.write_bytes(plistlib.dumps({**self.content(root), 'Label': label}))
        return label, path

    def test_migrates_own_legacy_job_and_reinstall_keeps_one_job(self):
        root = self.root / 'one'
        label, legacy = self.legacy(root)
        for _ in range(2):
            install(self.content(root), root / 'https_broker.py', [label], self.jobs, self.execute)
        self.assertFalse(legacy.exists())
        self.assertEqual(len(list(self.jobs.glob('*.plist'))), 1)
        stopped = [args[-1].split('/')[-1] for args in self.calls if args[1] == 'bootout']
        self.assertEqual(stopped, [label, self.content(root)['Label']])

    def test_legacy_job_for_another_deployment_is_untouched(self):
        label, legacy = self.legacy(self.root / 'one')
        before = legacy.read_bytes()
        root = self.root / 'two'
        install(self.content(root), root / 'https_broker.py', [label], self.jobs, self.execute)
        self.assertEqual(legacy.read_bytes(), before)
        self.assertEqual([args for args in self.calls if args[1] == 'bootout'], [])
        with self.assertRaises(ValueError):
            remove(label, root / 'https_broker.py', self.jobs, self.execute)
        self.assertEqual(legacy.read_bytes(), before)

    def test_refuses_to_replace_conflicting_namespaced_job(self):
        root = self.root / 'one'
        content = self.content(root)
        self.jobs.mkdir()
        path = self.jobs / (content['Label'] + '.plist')
        path.write_bytes(plistlib.dumps({**content, 'ProgramArguments': ['/other/script.py']}))
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            install(content, root / 'https_broker.py', [], self.jobs, self.execute)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.calls, [])

    def test_missing_plist_does_not_authorize_unloading_a_job(self):
        remove(self.content(self.root)['Label'], self.root / 'https_broker.py', self.jobs, self.execute)
        self.assertEqual(self.calls, [])

    def test_recovery_and_broker_have_distinct_stable_labels(self):
        broker = label_for('https-preview-broker', self.root)
        recovery = label_for('container-recovery', self.root)
        self.assertNotEqual(broker, recovery)
        self.assertEqual(broker, label_for('https-preview-broker', self.root / 'child/..'))

    def test_symlinked_plist_cannot_change_another_installation(self):
        root = self.root / 'one'
        content = self.content(root)
        self.jobs.mkdir()
        target = self.root / 'other.plist'
        target.write_bytes(plistlib.dumps(content))
        (self.jobs / (content['Label'] + '.plist')).symlink_to(target)
        with self.assertRaises(ValueError):
            install(content, root / 'https_broker.py', [], self.jobs, self.execute)
        self.assertEqual(plistlib.loads(target.read_bytes()), content)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()

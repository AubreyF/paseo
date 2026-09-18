import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from host_config import discover


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'compose.yaml').write_text('services: {}')
        self.container = {'Name': '/test-paseo', 'Mounts': [
            {'Destination': '/home/paseo', 'Type': 'bind', 'Source': str(self.root / 'data/home'), 'RW': True},
        ]}

    def discover(self):
        with patch('host_config.subprocess.check_output', return_value=json.dumps([self.container])):
            return discover('test-paseo', '/usr/bin/docker', 'default')[0]

    def test_unified_recipe_needs_no_hostname_file(self):
        config = self.discover()
        self.assertEqual(config['deployment'], str(self.root))
        self.assertEqual(config['container'], 'test-paseo')

    def test_legacy_hostname_mount_is_accepted(self):
        self.container['Mounts'].append({'Destination': '/etc/personal-tailscale/hostname', 'Source': str(self.root / 'tailscale-hostname'), 'Type': 'bind', 'RW': False})
        self.assertEqual(self.discover()['deployment'], str(self.root))

    def test_unrecognized_layout_is_rejected(self):
        self.container['Mounts'][0]['Source'] = str(self.root / 'other/home')
        with self.assertRaisesRegex(ValueError, 'mounts disagree'):
            self.discover()


if __name__ == '__main__':
    unittest.main()

import unittest
from network import serve_action


class NetworkTests(unittest.TestCase):
    def test_empty_node_needs_daemon_route(self):
        self.assertEqual(serve_action('node.example.ts.net', {}), 'create')

    def test_existing_daemon_route_is_preserved(self):
        config = {'TCP': {'443': {'HTTPS': True}}, 'Web': {
            'node.example.ts.net:443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:6767'}}},
            'node.example.ts.net:44444': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:3000'}}},
        }}
        self.assertEqual(serve_action('node.example.ts.net', config), 'keep')

    def test_foreign_route_cannot_be_replaced(self):
        config = {'TCP': {'443': {'HTTPS': True}}, 'Web': {
            'node.example.ts.net:443': {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:9000'}}},
        }}
        with self.assertRaisesRegex(ValueError, 'already owned'):
            serve_action('node.example.ts.net', config)

    def test_public_funnel_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Funnel'):
            serve_action('node.example.ts.net', {'AllowFunnel': {'node.example.ts.net:443': True}})

    def test_invalid_hostname_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'DNS'):
            serve_action('https://node.example.ts.net', {})


if __name__ == '__main__':
    unittest.main()

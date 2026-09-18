"""Wait for administrator enrollment, then publish only this daemon's route."""
import json
import re
import subprocess
import sys
import time


def serve_action(hostname, config):
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]*\.ts\.net', hostname):
        raise ValueError('Tailscale has not supplied a valid node DNS name')
    if any(config.get('AllowFunnel', {}).values()):
        raise ValueError('Funnel is enabled; administrator review is required')
    endpoint = hostname + ':443'
    tcp = config.get('TCP', {}).get('443')
    web = config.get('Web', {})
    expected = {'Handlers': {'/': {'Proxy': 'http://127.0.0.1:6767'}}}
    if tcp == {'HTTPS': True} and web.get(endpoint) == expected:
        return 'keep'
    if tcp or any(key.endswith(':443') for key in web):
        raise ValueError('HTTPS 443 is already owned by another route; refusing to replace it')
    return 'create'


def tailscale(*args):
    return subprocess.check_output(
        ['/usr/local/bin/tailscale', '--socket=/run/tailscale/tailscaled.sock', *args],
        timeout=30, text=True,
    )


def main():
    print('Waiting for Tailscale enrollment; run connect.sh from the deployment directory.', file=sys.stderr)
    while True:
        try:
            status = json.loads(tailscale('status', '--json'))
            if status.get('BackendState') == 'Running':
                break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            pass
        time.sleep(2)
    hostname = status['Self']['DNSName'].rstrip('.')
    config = json.loads(tailscale('serve', 'status', '--json'))
    if serve_action(hostname, config) == 'create':
        # CLI output can contain an HTTPS enablement link; keep it out of stdout,
        # which start-paseo reads as the exact allowed hostname.
        print(tailscale('serve', '--bg', '--https=443', 'http://127.0.0.1:6767'), file=sys.stderr)
        if serve_action(hostname, json.loads(tailscale('serve', 'status', '--json'))) != 'keep':
            raise ValueError('Tailscale did not retain the daemon HTTPS route')
    print(hostname)


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--url']:
            status = json.loads(tailscale('status', '--json'))
            print('https://' + status['Self']['DNSName'].rstrip('.'))
        else:
            main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error))

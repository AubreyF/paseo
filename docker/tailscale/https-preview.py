#!/usr/bin/env python3
"""Administrator-only private HTTPS mapping for one registered preview."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(os.environ['PASEO_DEPLOYMENT_DIR']).expanduser().resolve()
CONTAINER = os.environ['PASEO_CONTAINER_NAME']
DOCKER = [os.environ.get('PASEO_DOCKER_BIN', '/usr/local/bin/docker'), '--context', os.environ.get('PASEO_DOCKER_CONTEXT', 'desktop-linux')]
TS = ['exec', CONTAINER, '/usr/local/bin/tailscale', '--socket=/run/tailscale/tailscaled.sock']


def docker(args):
    return subprocess.check_output(DOCKER + args, text=True, timeout=30)


if sys.platform != 'darwin' or len(sys.argv) != 4:
    raise SystemExit('Run on the Mac host: https-preview.py WORKSPACE_ID SCRIPT HTTPS_PORT')
workspace, script, port_text = sys.argv[1:]
port = int(port_text)
if port < 32768 or port > 60999:
    raise SystemExit('Use an unused HTTPS port in the approved range 32768 through 60999')
state = json.loads(docker(['exec', '--user', 'paseo', CONTAINER, '/home/paseo/.local/bin/paseo-preview', 'status']))
entry = next((item for item in state['services'] if item['workspaceId'] == workspace and item['scriptName'] == script and item['enabled']), None)
if entry is None:
    raise SystemExit('Start and register the preview with paseo-preview first')
if any(item.get('port') == port for item in state['services']):
    raise SystemExit('HTTPS port conflicts with a registered preview port')
node = json.loads(docker(TS + ['status', '--json']))
hostname = node['Self']['DNSName'].rstrip('.')
config = json.loads(docker(TS + ['serve', 'status', '--json']))
target = f"http://127.0.0.1:{entry['port']}"
address = f'{hostname}:{port}'
existing = config.get('Web', {}).get(address, {}).get('Handlers', {}).get('/', {}).get('Proxy')
if str(port) in config.get('TCP', {}) and existing != target:
    raise SystemExit('Requested port already has another Tailscale mapping; leave it intact')
# A loopback listener might not appear in Tailscale Serve configuration.
docker(['exec', '--user', 'paseo', CONTAINER, 'node', '-e',
        "const s=require('node:net').createServer();s.on('error',()=>process.exit(1));s.listen(Number(process.argv[1]),'0.0.0.0',()=>s.close());", str(port)])
docker(TS + ['serve', '--bg', f'--https={port}', target])
updated = json.loads(docker(TS + ['serve', 'status', '--json']))
if updated['Web'][address]['Handlers']['/']['Proxy'] != target:
    raise SystemExit('Serve mapping did not match the requested preview')
if updated.get('AllowFunnel'):
    raise SystemExit('Unexpected Funnel configuration; inspect before proceeding')
url = f'https://{address}/'
subprocess.run(['/usr/bin/curl', '-fsS', '--max-time', '20', '-o', '/dev/null', url], check=True)
receipt = ROOT / 'https-previews.json'
records = json.loads(receipt.read_text()) if receipt.exists() else {}
records[address] = {'workspaceId': workspace, 'scriptName': script, 'target': target, 'url': url}
receipt.write_text(json.dumps(records, indent=2) + '\n')
receipt.chmod(0o600)
print(url)

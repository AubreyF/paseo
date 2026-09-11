#!/usr/bin/env python3
"""Install the reviewed login agent without stopping Docker or Paseo."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

if sys.platform != 'darwin':
    raise SystemExit('Install on the macOS Docker host only')
root = Path(os.environ['PASEO_DEPLOYMENT_DIR']).expanduser().resolve()
if not (root / 'compose.yaml').is_file():
    raise SystemExit('Existing private deployment is required')
subprocess.run([os.environ.get('PASEO_DOCKER_BIN', '/usr/local/bin/docker'), '--context', os.environ.get('PASEO_DOCKER_CONTEXT', 'desktop-linux'), 'inspect', os.environ['PASEO_CONTAINER_NAME'], '--format', '{{.Id}}'], check=True)
script = root / 'host-recovery.py'
shutil.copyfile(Path(__file__).with_name('host-recovery.py'), script)
script.chmod(0o700)
label = os.environ.get('PASEO_RECOVERY_LABEL', 'local.paseo.container-recovery')
plist = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
plist.parent.mkdir(parents=True, exist_ok=True)
content = {
    'Label': label,
    'ProgramArguments': [str(Path(sys.executable).resolve()), str(script)],
    'RunAtLoad': True,
    'StartInterval': 60,
    'ProcessType': 'Background',
    'LowPriorityIO': True,
    'Nice': 10,
    'StandardOutPath': str(root / 'recovery.stdout.log'),
    'StandardErrorPath': str(root / 'recovery.stderr.log'),
    'EnvironmentVariables': {
        'PATH': '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(Path.home()),
        'PASEO_DEPLOYMENT_DIR': str(root),
        'PASEO_CONTAINER_NAME': os.environ['PASEO_CONTAINER_NAME'],
        'PASEO_ROLLBACK_CONTAINER_NAME': os.environ['PASEO_ROLLBACK_CONTAINER_NAME'],
        'PASEO_DOCKER_BIN': os.environ.get('PASEO_DOCKER_BIN', '/usr/local/bin/docker'),
        'PASEO_DOCKER_CONTEXT': os.environ.get('PASEO_DOCKER_CONTEXT', 'desktop-linux'),
    },
}
with plist.open('wb') as file:
    plistlib.dump(content, file)
plist.chmod(0o600)
domain = f'gui/{os.getuid()}'
existing = subprocess.run(['/bin/launchctl', 'print', domain + '/' + label], capture_output=True)
if existing.returncode == 0:
    subprocess.run(['/bin/launchctl', 'bootout', domain + '/' + label], check=True)
subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(plist)], check=True)
print(f'Installed {label}. Use {script} pause before maintenance, resume afterward.')

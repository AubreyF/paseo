#!/usr/bin/env python3
"""Install the reviewed login agent without stopping Docker or Paseo."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

if sys.platform != 'darwin':
    raise SystemExit('Install on the macOS Docker host only')
sys.path.insert(0, str(Path(__file__).resolve().parent))
from host_config import load
from launch_agent import install, label_for, owned_plist
config = load()
root = Path(config['deployment'])
label = os.environ.get('PASEO_RECOVERY_LABEL', label_for('container-recovery', root))
owned_plist(label, root / 'host-recovery.py', Path.home() / 'Library/LaunchAgents')
# COMPAT(shared-recovery-label): added in v0.7.2, remove after 2027-03-16.
previous_label = config.get('recoveryLabel', 'local.paseo.container-recovery')
config['recoveryLabel'] = label
if not (root / 'compose.yaml').is_file():
    raise SystemExit('Existing private deployment is required')
subprocess.run([config['docker'], '--context', config['context'], 'inspect', config['container'], '--format', '{{.Id}}'], check=True)
shutil.copyfile(Path(__file__).with_name('host_config.py'), root / 'host_config.py')
(root / 'host_config.py').chmod(0o700)
shutil.copyfile(Path(__file__).with_name('launch_agent.py'), root / 'launch_agent.py')
(root / 'launch_agent.py').chmod(0o700)
from https_broker import atomic
atomic(root / 'host-config.json', config)
script = root / 'host-recovery.py'
shutil.copyfile(Path(__file__).with_name('host-recovery.py'), script)
script.chmod(0o700)
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
    'EnvironmentVariables': {'PATH': '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(Path.home())},
}
install(content, script, [previous_label])
print(f'Installed {label}. Use {script} pause before maintenance, resume afterward.')

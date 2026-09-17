"""Own login jobs by deployment path, including migration from shared labels."""
import hashlib
import os
from pathlib import Path
import plistlib
import re
import subprocess
import tempfile


def label_for(kind, deployment):
    identity = hashlib.sha256(str(Path(deployment).resolve()).encode()).hexdigest()[:20]
    return f'local.paseo.{kind}.{identity}'


def owned_plist(label, script, directory):
    if not re.fullmatch(r'[A-Za-z0-9._-]+', label):
        raise ValueError('Invalid login-agent label')
    path = directory / (label + '.plist')
    if path.is_symlink():
        raise ValueError('Login-agent plist must not be a symlink')
    if not path.exists():
        return None
    record = plistlib.loads(path.read_bytes())
    if record.get('Label') != label or str(script) not in record.get('ProgramArguments', []):
        raise ValueError('Login-agent label belongs to another installation: ' + label)
    return path


def remove(label, script, directory=None, run=subprocess.run):
    directory = directory or Path.home() / 'Library/LaunchAgents'
    path = owned_plist(label, script, directory)
    if path is None:
        return
    target = f'gui/{os.getuid()}/{label}'
    if run(['/bin/launchctl', 'print', target], capture_output=True).returncode == 0:
        run(['/bin/launchctl', 'bootout', target], check=True)
    path.unlink()


def install(content, script, previous_labels, directory=None, run=subprocess.run):
    directory = directory or Path.home() / 'Library/LaunchAgents'
    label = content['Label']
    owned_plist(label, script, directory)
    # An old shared label can belong to a sibling. Only migrate our own job.
    previous = []
    for candidate in set(previous_labels) - {label}:
        try:
            if owned_plist(candidate, script, directory):
                previous.append(candidate)
        except ValueError:
            continue
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (label + '.plist')
    descriptor, name = tempfile.mkstemp(dir=directory, prefix=label + '.')
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            plistlib.dump(content, stream)
        for candidate in [*previous, label]:
            remove(candidate, script, directory, run)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    run(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(path)], check=True)

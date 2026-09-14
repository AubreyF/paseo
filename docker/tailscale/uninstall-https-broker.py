#!/usr/bin/env python3
"""Remove only broker publication capability. Leave application processes alone."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from host_config import load
from https_broker import Broker, atomic

if __name__ == '__main__':
    c = load()
    label = 'local.paseo.https-preview-broker'
    subprocess.run(['/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{label}'], capture_output=True)
    root = Path(c['deployment'])
    with (root / 'https-broker.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        broker = Broker(c)
        broker.runtime.preflight()
        for entry in broker.ledger['entries'].values():
            entry.update(desired='stopped', stoppedAt=time.time(), status='stopped')
            broker.save()
            if entry.get('backend'):
                broker.remove(entry)
        atomic(Path(c['channel']) / 'disabled.json', {'disabled': True}, mode=0o644)
        (Path.home() / 'Library/LaunchAgents' / (label + '.plist')).unlink(missing_ok=True)
        print('Broker disabled. Owned routes removed; application processes and unrelated mappings preserved.')

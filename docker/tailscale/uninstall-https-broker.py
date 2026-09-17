#!/usr/bin/env python3
"""Remove only broker publication capability. Leave application processes alone."""
import fcntl
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from host_config import load
from launch_agent import remove
from https_broker import Broker, atomic

if __name__ == '__main__':
    c = load()
    root = Path(c['deployment'])
    # COMPAT(shared-broker-label): added in v0.7.2, remove after 2027-03-16.
    label = c.get('brokerLabel', 'local.paseo.https-preview-broker')
    remove(label, root / 'https_broker.py')
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
        print('Broker disabled. Owned routes removed; application processes and unrelated mappings preserved.')

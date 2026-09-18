#!/usr/bin/env python3
"""Administrator compatibility entry point, using the same serialized broker."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import json
import time
import uuid
import fcntl
from host_config import load
from https_broker import Broker

if __name__ == '__main__':
    if sys.platform != 'darwin' or len(sys.argv) != 4:
        raise SystemExit('Run on the Mac host: https-preview.py WORKSPACE_ID SERVICE HTTPS_PORT')
    try:
        c = load()
        with (Path(c['deployment']) / 'https-broker.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            broker = Broker(c)
            broker.runtime.preflight()
            result = broker.handle({'id': str(uuid.uuid4()), 'createdAt': time.time(), 'operation': 'start', 'workspaceId': sys.argv[1], 'service': sys.argv[2], 'preferredPort': int(sys.argv[3])})
            print(json.dumps(result))
    except ValueError as error:
        raise SystemExit(str(error))

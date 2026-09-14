#!/usr/bin/env python3
"""Host-only recovery. Never recreates containers or restarts a running daemon."""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from host_config import load
CONFIG = load()
ROOT = Path(CONFIG['deployment'])
DOCKER = CONFIG['docker']
CONTAINER = CONFIG['container']
OLD_CONTAINER = CONFIG.get('rollback')
PAUSED = ROOT / 'recovery.paused'
STATE = ROOT / 'recovery-status.json'


def command(args, timeout=20):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=True)


def docker(*args, timeout=20):
    return command([DOCKER, '--context', CONFIG['context'], *args], timeout)


def write_state(state):
    temp = STATE.with_suffix('.tmp')
    temp.write_text(json.dumps(state, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(STATE)


def main():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    action = sys.argv[1] if len(sys.argv) > 1 else 'check'
    if action == 'pause':
        PAUSED.touch(mode=0o600)
        print('Automatic recovery paused. Running services are unchanged.')
        return
    if action == 'resume':
        PAUSED.unlink(missing_ok=True)
        STATE.unlink(missing_ok=True)
    elif action == 'status':
        print(json.dumps({'paused': PAUSED.exists(), 'status': json.loads(STATE.read_text()) if STATE.exists() else None}, indent=2))
        return
    elif action != 'check':
        raise SystemExit('Usage: host-recovery.py check|pause|resume|status')
    if PAUSED.exists():
        return
    with (ROOT / 'recovery.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        state = json.loads(STATE.read_text()) if STATE.exists() else {}
        now = time.time()
        state['checkedAt'] = now
        try:
            docker('info', '--format', '{{.ServerVersion}}', timeout=10)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            # Allow login initialization to settle; don't force-quit a starting or stuck Docker.
            running = subprocess.run(['/usr/bin/pgrep', '-x', 'Docker'], capture_output=True).returncode == 0
            attempts = state.get('dockerStartAttempts', 0)
            if not running and attempts < 3 and now - state.get('lastDockerStart', 0) >= 600:
                command(['/usr/bin/open', '-g', '-a', '/Applications/Docker.app'])
                state['dockerStartAttempts'] = attempts + 1
                state['lastDockerStart'] = now
            state['status'] = 'Docker unavailable; waiting for startup or manual recovery'
            write_state(state)
            return
        state['dockerStartAttempts'] = 0
        old = docker('inspect', OLD_CONTAINER, '--format', '{{.State.Running}}').stdout.strip() if OLD_CONTAINER else 'false'
        if old == 'true':
            state['status'] = 'Rollback container running; replacement recovery suppressed'
            write_state(state)
            return
        inspected = json.loads(docker('inspect', CONTAINER).stdout)[0]
        if not inspected['State']['Running']:
            attempts = state.get('containerStartAttempts', 0)
            if attempts >= 3:
                state['status'] = 'Container startup failed three times; inspect before resume'
                write_state(state)
                return
            if now - state.get('lastContainerStart', 0) < 300:
                return
            docker('start', CONTAINER, timeout=30)
            state['containerStartAttempts'] = attempts + 1
            state['lastContainerStart'] = now
            state['status'] = 'Started retained production container'
        elif inspected['State'].get('Health', {}).get('Status') == 'healthy':
            state['containerStartAttempts'] = 0
            # The helper is deliberately executed without root or Docker access.
            result = docker('exec', CONTAINER, '/usr/bin/setpriv',
                            '--reuid=paseo', '--regid=paseo', '--init-groups',
                            '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs',
                            '/home/paseo/.local/bin/paseo-preview', 'recover', timeout=180)
            state['previews'] = json.loads(result.stdout)
            state['status'] = 'Healthy'
            state['containerId'] = inspected['Id']
        else:
            state['status'] = 'Container running but not healthy; no forced restart'
        write_state(state)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        # Do not print subprocess output, which can contain private project data.
        print(f'Recovery check failed: {type(error).__name__}', file=sys.stderr)
        sys.exit(1)

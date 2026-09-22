"""Trusted Linux subreaper. Native JSON-RPC uses stdio; control uses fd 3."""
import ctypes
import json
import os
import select
import signal
import stat
import subprocess
import sys
import time


def main():
    directory = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    metadata = os.fstat(directory)
    if metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise RuntimeError("Unprotected custody directory")
    intent_fd = os.open("intent.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    with os.fdopen(intent_fd) as stream:
        intent = json.load(stream)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "Cannot establish child custody")
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    stopping = False

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    settled = False
    reason = "startup_failure"
    command_outcome = None
    try:
        child = subprocess.Popen(sys.argv[2:], close_fds=True)
        os.write(4, b"ready\n")
        os.close(4)
        deadline = time.monotonic() + 30
        reason = "native_exit"
        while child.poll() is None:
            if stopping:
                reason = "signal"
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                reason = "control_timeout"
                break
            if not select.select([3], [], [], min(remaining, 0.1))[0]:
                continue
            message = os.read(3, 4096)
            if not message:
                reason = "controller_eof"
                break
            # One-byte messages cannot be split into partial commands. Any
            # unknown input freezes; only trusted controller ticks renew life.
            if message.strip(b"t"):
                reason = "freeze"
                break
            deadline = time.monotonic() + 30
        if reason == "native_exit" and child.returncode is not None:
            command_outcome = {
                "exitCode": child.returncode if child.returncode >= 0 else None,
                "signal": -child.returncode if child.returncode < 0 else None,
            }
    finally:
        # Never spawn after freezing. Adopted descendants become direct children
        # as their parents die. pidfd + waitid verifies ownership before signaling.
        children_path = f"/proc/self/task/{os.getpid()}/children"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with open(children_path) as stream:
                children = list(map(int, stream.read().split()))
            for pid in children:
                if time.monotonic() >= deadline:
                    break
                try:
                    handle = os.pidfd_open(pid)
                except ProcessLookupError:
                    continue
                try:
                    try:
                        os.waitid(os.P_PIDFD, handle, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    except ChildProcessError:
                        continue
                    try:
                        signal.pidfd_send_signal(handle, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                finally:
                    os.close(handle)
            try:
                while time.monotonic() < deadline and os.waitpid(-1, os.WNOHANG)[0] != 0:
                    pass
            except ChildProcessError:
                settled = True
                break
            time.sleep(0.01)
        receipt = {"identity": intent, "settled": settled, "reason": reason,
                   "commandOutcome": command_outcome}
        fd = os.open("receipt.tmp", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        with os.fdopen(fd, "w") as stream:
            json.dump(receipt, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.rename("receipt.tmp", "receipt.json", src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
        os.close(directory)
    return 0 if settled else 1


if __name__ == "__main__":
    sys.exit(main())

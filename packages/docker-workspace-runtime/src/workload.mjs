import { spawn, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const encoded = process.env.PASEO_RUNTIME_EXEC;
if (!encoded) throw new Error("PASEO_RUNTIME_EXEC is required");
const request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
delete process.env.PASEO_RUNTIME_EXEC;
const execId = process.env.PASEO_RUNTIME_EXEC_ID;
delete process.env.PASEO_RUNTIME_EXEC_ID;
if (!execId || !/^[a-f0-9]+$/.test(execId)) throw new Error("PASEO_RUNTIME_EXEC_ID is required");
const pidFile = `/tmp/paseo-runtime-exec-${execId}.pid`;
const readyFifo = `/tmp/paseo-runtime-exec-${execId}.ready`;
const doneFile = `/tmp/paseo-runtime-exec-${execId}.done`;

if (request.stdio?.kind === "pty") {
  const resized = spawnSync(
    "stty",
    ["cols", String(request.stdio.cols), "rows", String(request.stdio.rows)],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (resized.status !== 0) throw new Error("Runtime PTY initial resize failed");
}

const child = spawn(request.argv[0], request.argv.slice(1), {
  cwd: request.cwd,
  env: request.env,
  detached: request.stdio?.kind !== "pty",
  stdio: ["inherit", "inherit", "inherit"],
});
if (!child.pid) throw new Error("Runtime workload did not start");

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  });
}
writeFileSync(pidFile, `${process.pid} ${child.pid}\n`);
writeFileSync(readyFifo, `${execId}\n`);

child.once("error", (error) => {
  rmSync(pidFile, { force: true });
  writeFileSync(doneFile, "done");
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 127;
});
child.once("exit", (code, signal) => {
  rmSync(pidFile, { force: true });
  writeFileSync(doneFile, "done");
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

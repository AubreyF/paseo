import { execFile } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { parseControllerLifetimeFd } from "./supervisor.js";

const execute = promisify(execFile);
const linuxTest = test.skipIf(process.platform !== "linux");

linuxTest("lifetime descriptor rejects invalid numbers and unsafe files", async () => {
  expect(parseControllerLifetimeFd(undefined)).toBeUndefined();
  for (const value of ["", "-1", "2", "3.5", "3e1", "Infinity"])
    expect(() => parseControllerLifetimeFd(value)).toThrow("integer");
  const root = await mkdtemp(join(tmpdir(), "supervisor-fd-"));
  const file = join(root, "lock");
  await writeFile(file, "", { mode: 0o600 });
  const fd = openSync(file, "r+");
  try {
    expect(parseControllerLifetimeFd(String(fd))).toBe(fd);
    await chmod(file, 0o644);
    expect(() => parseControllerLifetimeFd(String(fd))).toThrow("0600");
    await chmod(file, 0o600);
    await link(file, join(root, "alias"));
    expect(() => parseControllerLifetimeFd(String(fd))).toThrow("0600");
    await mkdir(join(root, "directory"));
    const directory = openSync(join(root, "directory"), "r");
    try {
      expect(() => parseControllerLifetimeFd(String(directory))).toThrow("0600");
    } finally {
      closeSync(directory);
    }
  } finally {
    closeSync(fd);
    await rm(root, { recursive: true, force: true });
  }
});

linuxTest.each(["fork", "spawn"])(
  "%s maps lifetime ownership to daemon FD 4 without passing it to descendants",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "supervisor-fd-spawn-"));
    const lock = join(root, "lock");
    const worker = join(root, "worker.mjs");
    const supervisor = join(root, "supervisor.mjs");
    await writeFile(lock, "", { mode: 0o600 });
    await writeFile(
      worker,
      `
    import { fstatSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const fd = Number(process.env.PASEO_CONTROLLER_LIFETIME_FD);
    if (fd !== 4) throw new Error('Wrong mapped descriptor');
    const held = fstatSync(fd);
    const probe = spawnSync(process.execPath, ['-e', \`
      const fs = require('node:fs');
      for (const entry of fs.readdirSync('/proc/self/fd')) {
        try {
          const info = fs.statSync('/proc/self/fd/' + entry);
          if (info.dev === \${held.dev} && info.ino === \${held.ino}) process.exit(42);
        } catch {}
      }
    \`], {stdio:['ignore','pipe','pipe']});
    if (probe.status !== 0) throw new Error('Lifetime descriptor leaked to descendant');
    process.send({type:'paseo:shutdown'});
    process.on('message', message => {
      if (message.type === 'paseo:graceful-shutdown') process.exit(0);
    });
  `,
    );
    await writeFile(
      supervisor,
      `
    import { openSync, fstatSync } from 'node:fs';
    import { runSupervisor } from ${JSON.stringify(new URL("./supervisor.ts", import.meta.url).href)};
    const fd = openSync(${JSON.stringify(lock)}, 'r+');
    runSupervisor({name:'fixture',startupMessage:'fixture',resolveWorkerEntry:()=>${JSON.stringify(worker)},
      workerExecArgv:[],workerArgs:[],controllerLifetimeFd:fd,
      workerEnv:{...process.env,PASEO_CONTROLLER_LIFETIME_FD:'999'},
      ${kind === "spawn" ? `resolveWorkerSpawnSpec:entry=>({command:process.execPath,args:[entry],env:{...process.env,PASEO_CONTROLLER_LIFETIME_FD:'888'}}),` : ""}
      onSupervisorExit:()=>{fstatSync(fd);console.log('lifetime-held-through-exit');}
    });
  `,
    );
    try {
      const result = await execute(process.execPath, ["--import", "tsx", supervisor], {
        timeout: 10000,
      });
      expect(result.stdout).toContain("lifetime-held-through-exit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

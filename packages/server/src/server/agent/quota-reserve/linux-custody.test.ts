import { test, expect } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import type { Writable } from "node:stream";
import { LinuxQuotaProcessCustody } from "./linux-custody.js";

const linux = test.skipIf(process.platform !== "linux");

linux("command failure remains distinct from successful descendant settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-custody-outcome-"));
  const custody = await LinuxQuotaProcessCustody.create({
    journalRoot: root,
    executable: "/usr/bin/python3",
    pythonExecutable: "/usr/bin/python3",
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    identity: {
      executionId: randomUUID(),
      authenticationGeneration: "fixture",
      attemptId: "fixture",
      ownershipGeneration: 1,
    },
  });
  const child = await custody.spawn("/usr/bin/python3", ["-c", "input(); raise SystemExit(7)"]);
  child.stdout.resume();
  child.stderr.resume();
  const exited = once(child, "exit");
  child.stdin.end("go\n");
  try {
    expect((await exited)[0]).toBe(0);
    await custody.settle(child);
    await expect(
      LinuxQuotaProcessCustody.readOutcome(custody.directory, custody.identity),
    ).resolves.toEqual({ exitCode: 7, signal: null });
    const path = join(custody.directory, "receipt.json");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    delete receipt.commandOutcome;
    await writeFile(path, JSON.stringify(receipt));
    await expect(
      LinuxQuotaProcessCustody.readSettlement(custody.directory, custody.identity),
    ).resolves.toBeUndefined();
    await expect(
      LinuxQuotaProcessCustody.readOutcome(custody.directory, custody.identity),
    ).rejects.toThrow("completion is unconfirmed");
  } finally {
    await custody.settle(child);
    await rm(root, { recursive: true, force: true });
  }
});

linux(
  "settles detached descendants through custody and rejects a different attempt receipt",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-custody-"));
    const custody = await LinuxQuotaProcessCustody.create({
      journalRoot: root,
      executable: "/usr/bin/python3",
      pythonExecutable: "/usr/bin/python3",
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      identity: {
        executionId: randomUUID(),
        authenticationGeneration: "fixture-auth",
        attemptId: "fixture-attempt",
        ownershipGeneration: 1,
      },
    });
    const child = await custody.spawn("/usr/bin/python3", [
      "-c",
      `
import os, subprocess, sys, time
descendant = subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(120)'], start_new_session=True)
print(descendant.pid, flush=True)
time.sleep(120)
`,
    ]);
    child.stderr.resume();
    try {
      const [data] = await once(child.stdout, "data");
      const descendant = Number(String(data).trim());
      expect(Number.isInteger(descendant)).toBe(true);
      process.kill(descendant, 0);
      await custody.settle(child);
      expect(() => process.kill(descendant, 0)).toThrow();
      await expect(
        LinuxQuotaProcessCustody.readSettlement(custody.directory, custody.identity),
      ).resolves.toBeUndefined();
      await expect(
        LinuxQuotaProcessCustody.readSettlement(custody.directory, {
          ...custody.identity,
          attemptId: "obsolete",
        }),
      ).rejects.toThrow("identity mismatch");
      await expect(custody.spawn("/usr/bin/python3", [])).rejects.toThrow("another native process");
      const receipt = JSON.parse(await readFile(join(custody.directory, "receipt.json"), "utf8"));
      expect(receipt.settled).toBe(true);
      expect(receipt.reason).toBe("freeze");
    } finally {
      await custody.settle(child);
      await rm(root, { recursive: true, force: true });
    }
  },
);

linux("refuses inherited credential variables and symlinked receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-custody-"));
  const options = {
    journalRoot: root,
    executable: "/usr/bin/python3",
    pythonExecutable: "/usr/bin/python3",
    cwd: root,
    env: { GITHUB_TOKEN: "synthetic" },
    identity: {
      executionId: randomUUID(),
      authenticationGeneration: "fixture-auth",
      attemptId: "fixture",
      ownershipGeneration: 1,
    },
  };
  try {
    await expect(LinuxQuotaProcessCustody.create(options)).rejects.toThrow("environment variable");
    const custody = await LinuxQuotaProcessCustody.create({
      ...options,
      env: {},
    });
    await expect(
      LinuxQuotaProcessCustody.readSettlement(custody.directory, custody.identity),
    ).rejects.toThrow();
    const outside = join(root, "forged.json");
    await writeFile(
      outside,
      JSON.stringify({
        identity: custody.identity,
        settled: true,
        reason: "freeze",
      }),
      { mode: 0o600 },
    );
    await symlink(outside, join(custody.directory, "receipt.json"));
    await expect(
      LinuxQuotaProcessCustody.readSettlement(custody.directory, custody.identity),
    ).rejects.toThrow();
    await rm(join(custody.directory, "receipt.json"));
    execFileSync("mkfifo", [join(custody.directory, "receipt.json")]);
    await expect(
      LinuxQuotaProcessCustody.readSettlement(custody.directory, custody.identity),
    ).rejects.toThrow("Unprotected custody receipt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

linux("controller pipe loss settles owned work without a transport shutdown callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "quota-custody-"));
  const custody = await LinuxQuotaProcessCustody.create({
    journalRoot: root,
    executable: "/usr/bin/python3",
    pythonExecutable: "/usr/bin/python3",
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
    identity: {
      executionId: randomUUID(),
      authenticationGeneration: "fixture-auth",
      attemptId: "fixture",
      ownershipGeneration: 1,
    },
  });
  const child = await custody.spawn("/usr/bin/python3", [
    "-c",
    "import time; print('started',flush=True); time.sleep(120)",
  ]);
  child.stderr.resume();
  try {
    await once(child.stdout, "data");
    const exited = once(child, "exit");
    (child.stdio[3] as Writable).end();
    await exited;
    await expect(
      LinuxQuotaProcessCustody.readSettlement(custody.directory, custody.identity),
    ).resolves.toBeUndefined();
    const receipt = JSON.parse(await readFile(join(custody.directory, "receipt.json"), "utf8"));
    expect(receipt.reason).toBe("controller_eof");
    expect(receipt.settled).toBe(true);
  } finally {
    await custody.settle(child);
    await rm(root, { recursive: true, force: true });
  }
});

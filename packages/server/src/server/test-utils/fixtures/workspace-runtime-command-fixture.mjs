#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import * as pty from "node-pty";

const operation = process.argv
  .slice(2)
  .find((value) =>
    ["describe", "create", "inspect", "exec", "signal", "pause", "resume", "destroy"].includes(
      value,
    ),
  );
const workspaceId = argument("--workspace-id");

try {
  if (operation === "describe") {
    writeJson({
      protocolVersion: 1,
      modes: argument("--modes") === "pipes" ? ["pipes"] : ["pipes", "pty"],
    });
  } else if (!workspaceId) {
    throw new Error("--workspace-id is required");
  } else if (operation === "exec") {
    await execute(workspaceId);
  } else if (operation === "signal") {
    await signal(workspaceId, requireArgument("--exec-id"), requireArgument("--signal"));
  } else {
    const request = JSON.parse(await readStream(process.stdin));
    switch (operation) {
      case "create":
        writeJson({ protocolVersion: 1, type: "state", state: await create(workspaceId, request) });
        break;
      case "inspect":
        writeJson({
          protocolVersion: 1,
          type: "inspection",
          inspection: await inspect(workspaceId, request.options),
        });
        break;
      case "pause":
        await setLifecycle(workspaceId, request.options, "paused");
        writeJson({ protocolVersion: 1, type: "ok" });
        break;
      case "resume":
        writeJson({
          protocolVersion: 1,
          type: "state",
          state: await setLifecycle(workspaceId, request.options, "ready"),
        });
        break;
      case "destroy":
        await rm(stateFile(workspaceId, request.options), { force: true });
        writeJson({ protocolVersion: 1, type: "ok" });
        break;
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function create(id, request) {
  const existing = await readState(id, request.options);
  if (existing) return existing;
  const root = request.input.project.source.path;
  const state = {
    workspaceId: id,
    root,
    revision: "fixture:1",
    executionDomainId: "fixture",
    lifecycle: "ready",
  };
  await mkdir(request.options.stateDirectory, { recursive: true });
  await writeFile(stateFile(id, request.options), JSON.stringify(state));
  return state;
}

async function inspect(id, options) {
  await applyInspectBarrier(options);
  const state = await readState(id, options);
  return state ? { status: state.lifecycle, state } : { status: "missing" };
}

async function setLifecycle(id, options, lifecycle) {
  const state = await readState(id, options);
  if (!state) throw new Error(`Fixture workspace is missing: ${id}`);
  const updated = { ...state, lifecycle };
  await writeFile(stateFile(id, options), JSON.stringify(updated));
  return updated;
}

async function execute(id) {
  const control = new Socket({ fd: 3, readable: true, writable: false });
  const lines = createInterface({ input: control, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error("spawn control is required");
  const envelope = JSON.parse(first.value);
  const state = await readState(id, envelope.options);
  if (!state) throw new Error(`Fixture workspace is missing: ${id}`);
  await writeFile(
    path.join(state.root, ".runtime-launch.json"),
    JSON.stringify({ argv: process.argv, purpose: envelope.purpose }),
  );
  if (envelope.stdio.kind === "pty") {
    await executePty(id, envelope, iterator, control);
    control.destroy();
    return;
  }
  const child = spawn(envelope.argv[0], envelope.argv.slice(1), {
    cwd: path.resolve(state.root, envelope.cwd ?? "."),
    env: envelope.env,
    detached: true,
    stdio: ["inherit", "inherit", "inherit"],
  });
  await writeFile(execFile(id, envelope.execId, envelope.options), String(child.pid));
  let forwardedSignal = null;
  const handlers = new Map();
  for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      forwardedSignal = signalName;
      killGroup(child.pid, signalName);
    };
    handlers.set(signalName, handler);
    process.on(signalName, handler);
  }
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signalName) => resolve({ code, signal: signalName }));
  });
  await rm(execFile(id, envelope.execId, envelope.options), { force: true });
  for (const [signalName, handler] of handlers) process.off(signalName, handler);
  const signalName = forwardedSignal ?? exit.signal;
  if (signalName) {
    process.removeAllListeners(signalName);
    process.kill(process.pid, signalName);
  } else {
    process.exitCode = exit.code ?? 1;
  }
}

async function executePty(id, envelope, controls, controlStream) {
  const events = new Socket({ fd: 4, readable: false, writable: true });
  const child = pty.spawn(envelope.argv[0], envelope.argv.slice(1), {
    cwd: path.resolve((await readState(id, envelope.options)).root, envelope.cwd ?? "."),
    env: envelope.env,
    name: envelope.stdio.term ?? "xterm-256color",
    cols: envelope.stdio.cols,
    rows: envelope.stdio.rows,
  });
  await writeFile(execFile(id, envelope.execId, envelope.options), String(child.pid));
  if (envelope.options.closePtyControl) setTimeout(() => controlStream.destroy(), 100);
  process.stdin.on("data", (data) => child.write(data.toString()));
  child.onData((data) => process.stdout.write(data));
  if (envelope.options.invalidPtyEvent) {
    setTimeout(
      () => events.end(`${JSON.stringify({ protocolVersion: 1, type: "invalid" })}\n`),
      100,
    );
  }
  let requestedSignal = null;
  void (async () => {
    while (true) {
      const next = await controls.next();
      if (next.done) return;
      const control = JSON.parse(next.value);
      if (control.type === "resize") {
        child.resize(control.cols, control.rows);
        events.write(
          `${JSON.stringify({ protocolVersion: 1, type: "resized", id: control.id })}\n`,
        );
      } else if (control.type === "signal") {
        requestedSignal = control.signal;
        child.kill(control.signal);
      } else throw new Error(`Unexpected PTY control: ${control.type}`);
    }
  })().catch((error) => {
    events.write(
      `${JSON.stringify({ protocolVersion: 1, type: "error", message: error.message })}\n`,
    );
    child.kill("SIGKILL");
  });
  const exit = await new Promise((resolve) =>
    child.onExit(({ exitCode, signal: signalNumber }) =>
      resolve({ exitCode, signal: signalNumber }),
    ),
  );
  await rm(execFile(id, envelope.execId, envelope.options), { force: true });
  process.stdin.destroy();
  if (envelope.options.invalidPtyEvent) return;
  events.write(`${JSON.stringify({ protocolVersion: 1, type: "eof" })}\n`);
  if (envelope.options.omitPtyExitEvent) {
    events.end();
    return;
  }
  const exitEvent = `${JSON.stringify({
    protocolVersion: 1,
    type: "exit",
    code: requestedSignal || exit.signal ? null : exit.exitCode,
    signal: requestedSignal,
  })}\n`;
  if (envelope.options.delayedPtyExitEvent) {
    const writer = spawn(
      process.execPath,
      [
        "-e",
        `setTimeout(()=>{require('node:fs').writeSync(4,${JSON.stringify(exitEvent)});},1000)`,
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ignore", events] },
    );
    writer.unref();
    events.destroy();
    return;
  }
  events.end(exitEvent);
}

async function signal(id, execId, signalName) {
  const { options } = JSON.parse(await readStream(process.stdin));
  const pid = Number(await readFile(execFile(id, execId, options), "utf8"));
  killGroup(pid, signalName);
  if (options.signalHelperFailure === "error") throw new Error("fixture signal helper failed");
  if (options.signalHelperFailure === "hang") await new Promise(() => {});
}

async function applyInspectBarrier(options) {
  if (!options.inspectBarrierDirectory) return;
  const next = path.join(options.inspectBarrierDirectory, "block-next-inspect");
  try {
    await rm(next);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await writeFile(path.join(options.inspectBarrierDirectory, "inspect-entered"), "entered");
  const release = path.join(options.inspectBarrierDirectory, "release-inspect");
  while (true) {
    try {
      await readFile(release);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function readState(id, options) {
  try {
    return JSON.parse(await readFile(stateFile(id, options), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function stateFile(id, options) {
  return path.join(options.stateDirectory, `${key(id)}.json`);
}

function execFile(id, execId, options) {
  return path.join(options.stateDirectory, `${key(id)}-${execId}.pid`);
}

function key(value) {
  return createHash("sha256").update(value).digest("hex");
}

function killGroup(pid, signalName) {
  try {
    process.kill(-pid, signalName);
  } catch {
    process.kill(pid, signalName);
  }
}

function argument(flag) {
  const index = process.argv.indexOf(flag, 2);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requireArgument(flag) {
  const value = argument(flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

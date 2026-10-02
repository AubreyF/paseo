import { expect, test } from "vitest";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import { InstallationRestarts, type RestartJournal } from "./restarts.js";

class MemoryJournal implements RestartJournal {
  jobs: RestartJob[] = [];
  failWrite = false;
  read() {
    return structuredClone(this.jobs);
  }
  write(jobs: RestartJob[]) {
    if (this.failWrite) throw new Error("disk unavailable");
    this.jobs = structuredClone(jobs);
  }
}

test("request-only callers cannot cause a restart, and approval is bound to the exact revision", async () => {
  const calls: string[] = [];
  const queue = new InstallationRestarts(new MemoryJournal(), {
    restart: async (target) => {
      calls.push(target);
      return "ready";
    },
  });
  const request = queue.request(
    { target: "host", reason: "Install reviewed release" },
    "container-agent",
  );
  await queue.drain();
  expect(calls).toEqual([]);
  expect(() => queue.decide(request.id, "wrong-revision", "approve")).toThrow("changed");
  queue.decide(request.id, request.revision, "approve");
  await Promise.all([queue.drain(), queue.drain()]);
  expect(calls).toEqual(["host"]);
  expect(queue.list()[0]?.status).toBe("succeeded");
  expect(() => queue.decide(request.id, request.revision, "approve")).toThrow("already decided");
});

test("expiry, rejection, and journal failure prevent dispatch", async () => {
  let now = Date.now();
  const journal = new MemoryJournal();
  const calls: string[] = [];
  const queue = new InstallationRestarts(
    journal,
    {
      restart: async (target) => {
        calls.push(target);
        return "ready";
      },
    },
    () => now,
  );
  const expired = queue.request({ target: "host", reason: "Prepared" }, "host-agent");
  now += 31 * 60_000;
  expect(() => queue.decide(expired.id, expired.revision, "approve")).toThrow("expired");
  const rejected = queue.request(
    { target: "container-daemon", reason: "Prepared" },
    "container-agent",
  );
  queue.decide(rejected.id, rejected.revision, "reject");
  await queue.drain();
  const prepared = queue.request({ target: "host", reason: "Prepared again" }, "host-agent");
  journal.failWrite = true;
  expect(() => queue.decide(prepared.id, prepared.revision, "approve")).toThrow("disk unavailable");
  await queue.drain();
  expect(calls).toEqual([]);
});

test("a coordinator interruption never repeats an approved or running disruptive action", async () => {
  const journal = new MemoryJournal();
  const first = new InstallationRestarts(journal, { restart: async () => "ready" });
  const request = first.request({ target: "host", reason: "Prepared" }, "owner");
  first.decide(request.id, request.revision, "approve");
  const calls: string[] = [];
  const restored = new InstallationRestarts(journal, {
    restart: async (target) => {
      calls.push(target);
      return "ready";
    },
  });
  await restored.drain();
  expect(calls).toEqual([]);
  expect(restored.list()[0]?.status).toBe("failed");
  expect(restored.list()[0]?.detail).toContain("Inspect target");
});

test("readiness failure stays failed rather than retrying a restart", async () => {
  let calls = 0;
  const queue = new InstallationRestarts(new MemoryJournal(), {
    restart: async () => {
      calls++;
      throw new Error("readiness deadline exceeded");
    },
  });
  const request = queue.request({ target: "container-daemon", reason: "Prepared" }, "owner");
  queue.decide(request.id, request.revision, "approve");
  await queue.drain();
  await queue.drain();
  expect(calls).toBe(1);
  expect(queue.list()[0]).toMatchObject({
    status: "failed",
    detail: "readiness deadline exceeded",
  });
});

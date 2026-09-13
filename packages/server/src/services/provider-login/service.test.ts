import { expect, it } from "vitest";
import { ProviderLoginService } from "./service.js";
import type { ProviderLoginSession } from "./session.js";

class LoginSession implements ProviderLoginSession {
  scope = "account-one";
  starts = 0;
  cancellations = 0;
  disposals = 0;
  complete: (success: boolean) => void = () => {};
  async start(onComplete: (success: boolean) => void) {
    this.starts++;
    this.complete = onComplete;
    return { verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" };
  }
  async readAccountLabel() {
    return "one@example.test";
  }
  async cancel() {
    this.cancellations++;
  }
  async dispose() {
    this.disposals++;
  }
}
function fixture(sessions = [new LoginSession()]) {
  let opened = 0;
  const connected: string[] = [];
  const deadlines: Array<() => void> = [];
  const service = new ProviderLoginService({
    getClient: () => ({ openAccountLoginSession: async () => sessions[opened++] }),
    onConnected: (id) => {
      connected.push(id);
    },
    now: () => 0,
    schedule: (callback) => {
      deadlines.push(callback);
      return () => {};
    },
  });
  return { service, sessions, connected, deadlines, opened: () => opened };
}
it("deduplicates starts, preserves the code across reads, and refreshes usage after success", async () => {
  const f = fixture();
  const initial = f.service.start("one");
  expect(f.service.start("one")).toEqual(initial);
  await expect.poll(() => f.service.read("one").status).toBe("waiting");
  const challenge = f.service.read("one");
  expect(f.service.start("one")).toEqual(challenge);
  expect(f.opened()).toBe(1);
  expect(challenge).toMatchObject({
    status: "waiting",
    userCode: "ABCD-1234",
    expiresAt: "1970-01-01T00:15:00.000Z",
  });
  f.sessions[0].complete(true);
  await expect
    .poll(() => f.service.read("one"))
    .toMatchObject({ status: "succeeded", accountLabel: "one@example.test" });
  expect(f.connected).toEqual(["one"]);
  expect(f.sessions[0].disposals).toBe(1);
  await f.service.dispose();
});
it("expires attempts and ignores late completion", async () => {
  const f = fixture();
  f.service.start("one");
  await expect.poll(() => f.service.read("one").status).toBe("waiting");
  f.deadlines[0]();
  f.sessions[0].complete(true);
  expect(f.service.read("one")).toMatchObject({
    status: "failed",
    message: "The sign-in code expired. Start again to get a new code.",
  });
  expect(f.connected).toEqual([]);
  expect(f.sessions[0].disposals).toBe(1);
  await f.service.dispose();
});
it("cancels only the requested attempt and allows a new code", async () => {
  const f = fixture([new LoginSession(), new LoginSession()]);
  const first = f.service.start("one");
  if (first.status === "idle") throw new Error("Expected attempt");
  await expect.poll(() => f.service.read("one").status).toBe("waiting");
  await f.service.cancel("one", first.attemptId);
  expect(f.sessions[0].cancellations).toBe(1);
  expect(f.service.read("one").status).toBe("cancelled");
  f.service.start("one");
  await expect.poll(() => f.service.read("one").status).toBe("waiting");
  await f.service.cancel("one", first.attemptId);
  expect(f.service.read("one").status).toBe("waiting");
  f.sessions[0].complete(true);
  expect(f.connected).toEqual([]);
  await f.service.dispose();
  expect(f.sessions[1].disposals).toBe(1);
});
it("isolates accounts while sharing one attempt for aliases of the same directory", async () => {
  const other = new LoginSession();
  other.scope = "account-two";
  const f = fixture([new LoginSession(), new LoginSession(), other]);
  f.service.start("one");
  await expect.poll(() => f.service.read("one").status).toBe("waiting");
  f.service.start("alias");
  await expect.poll(() => f.service.read("alias").status).toBe("waiting");
  expect(f.sessions[1].starts).toBe(0);
  expect(f.service.read("alias")).toEqual(f.service.read("one"));
  f.service.start("two");
  await expect.poll(() => f.service.read("two").status).toBe("waiting");
  f.sessions[0].complete(false);
  await expect.poll(() => f.service.read("alias").status).toBe("failed");
  expect(f.service.read("two").status).toBe("waiting");
  await f.service.dispose();
});
it("cleans up a process that finishes opening after cancellation", async () => {
  const session = new LoginSession();
  let resolve!: (session: ProviderLoginSession) => void;
  const opening = new Promise<ProviderLoginSession>((done) => {
    resolve = done;
  });
  const service = new ProviderLoginService({
    getClient: () => ({ openAccountLoginSession: () => opening }),
    onConnected: () => {},
    schedule: () => () => {},
  });
  const attempt = service.start("one");
  if (attempt.status === "idle") throw new Error("Expected attempt");
  await service.cancel("one", attempt.attemptId);
  resolve(session);
  await expect.poll(() => session.disposals).toBe(1);
  expect(session.starts).toBe(0);
  await service.dispose();
});
it("exposes start failures without leaking provider output", async () => {
  const service = new ProviderLoginService({
    getClient: () => ({
      openAccountLoginSession: async () => {
        throw new Error("secret output");
      },
    }),
    onConnected: () => {},
  });
  service.start("one");
  await expect.poll(() => service.read("one").status).toBe("failed");
  expect(JSON.stringify(service.read("one"))).not.toContain("secret output");
  await service.dispose();
});

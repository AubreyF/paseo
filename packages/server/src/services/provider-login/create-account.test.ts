import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { DaemonConfigStore } from "../../server/daemon-config-store.js";
import { loadPersistedConfig } from "../../server/persisted-config.js";
import { createCodexAccount } from "./create-account.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const paseoHome = mkdtempSync(path.join(tmpdir(), "codex-accounts-"));
  homes.push(paseoHome);
  const initial = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: false },
    providers: {
      primary: { extends: "codex", label: "Primary", env: { CODEX_HOME: "/existing/home" } },
    },
    agentProfiles: [{ id: "preset", name: "Existing", provider: "primary" }],
  });
  return { paseoHome, store: new DaemonConfigStore(paseoHome, initial) };
}

it("persists distinct account homes without touching existing providers or presets", () => {
  const f = fixture();
  const before = f.store.get();
  const first = createCodexAccount({ ...f, creationId: randomUUID(), name: " Work " });
  const second = createCodexAccount({ ...f, creationId: randomUUID(), name: "Personal" });
  const providers = f.store.get().providers;
  expect(first.name).toBe("Work");
  expect(providers[first.providerId]).toEqual({
    extends: "codex",
    label: "Work",
    enabled: true,
    env: { CODEX_HOME: path.join(f.paseoHome, "codex-accounts", first.providerId) },
  });
  expect(providers[first.providerId].env).not.toEqual(providers[second.providerId].env);
  expect(providers.primary).toEqual(before.providers.primary);
  expect(f.store.get().agentProfiles).toEqual(before.agentProfiles);
  expect(loadPersistedConfig(f.paseoHome).agents?.providers?.[first.providerId]).toEqual(
    providers[first.providerId],
  );
});

it("reconciles retries after reopening the store without allocating another account", () => {
  const f = fixture();
  const creationId = randomUUID();
  const first = createCodexAccount({ ...f, creationId, name: "Work" });
  const reopened = new DaemonConfigStore(f.paseoHome, f.store.get());
  expect(
    createCodexAccount({ ...f, store: reopened, creationId, name: "Changed after timeout" }),
  ).toEqual(first);
  expect(Object.keys(reopened.get().providers)).toHaveLength(2);
});

it("rejects blank names, traversal identifiers, and conflicting configurations", () => {
  const f = fixture();
  expect(() => createCodexAccount({ ...f, creationId: randomUUID(), name: "  " })).toThrow(
    "account name",
  );
  expect(() => createCodexAccount({ ...f, creationId: "../../existing", name: "Work" })).toThrow();
  const creationId = randomUUID();
  const providerId = `codex-account-${creationId}`;
  f.store.patch({
    providers: {
      [providerId]: { extends: "codex", label: "Existing", env: { CODEX_HOME: "/another/home" } },
    },
  });
  expect(() => createCodexAccount({ ...f, creationId, name: "Work" })).toThrow("already in use");
  expect(f.store.get().providers[providerId].env).toEqual({ CODEX_HOME: "/another/home" });
});

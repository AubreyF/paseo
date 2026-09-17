import { expect, test } from "vitest";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuotaGovernorStore } from "../agent/quota-reserve/governor-store.js";
import {
  loadGovernedScheduleRuntimeFactory,
  type GovernedScheduleRuntimeContext,
} from "./governed-runtime.js";

test.skipIf(process.platform === "win32")(
  "loads an explicitly installed runtime and rejects invalid exports without fallback",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "governed-module-")));
    const context: GovernedScheduleRuntimeContext = {
      paseoHome: root,
      store: new QuotaGovernorStore(join(root, "quota")),
      readObservation: async () => ({ status: "unavailable", reason: "read_failed" }),
      captureClient: () => {
        throw new Error("No worker in fixture");
      },
    };
    try {
      const good = join(root, "runtime.mjs");
      await writeFile(
        good,
        `export async function createGovernedScheduleRuntime(context) {
      return { readObservation: context.readObservation, reconcile: async () => {},
        reconcilePreparation: async () => 'clear', prepare: async () => ({kind:'deferred',reason:'fixture',custody:'none'}), stop: async () => {} };
    }`,
        { mode: 0o600 },
      );
      const factory = await loadGovernedScheduleRuntimeFactory(good);
      if (!factory) throw new Error("Missing fixture factory");
      const runtime = await factory(context);
      expect(await runtime.readObservation("fixture")).toEqual({
        status: "unavailable",
        reason: "read_failed",
      });
      await runtime.stop();
      await expect(loadGovernedScheduleRuntimeFactory(undefined)).resolves.toBeUndefined();
      await expect(loadGovernedScheduleRuntimeFactory("relative.mjs")).rejects.toThrow("absolute");
      const invalid = join(root, "invalid.mjs");
      await writeFile(invalid, "export const createGovernedScheduleRuntime = false;", {
        mode: 0o600,
      });
      await expect(loadGovernedScheduleRuntimeFactory(invalid)).rejects.toThrow(
        "export is missing",
      );
      const incomplete = join(root, "incomplete.mjs");
      await writeFile(
        incomplete,
        "export async function createGovernedScheduleRuntime() { return {}; }",
        { mode: 0o600 },
      );
      const broken = await loadGovernedScheduleRuntimeFactory(incomplete);
      if (!broken) throw new Error("Missing broken fixture");
      await expect(broken(context)).rejects.toThrow("contract is incomplete");
      const alias = join(root, "alias.mjs");
      await symlink(good, alias);
      await expect(loadGovernedScheduleRuntimeFactory(alias)).rejects.toThrow("physical module");
      await chmod(good, 0o666);
      await expect(loadGovernedScheduleRuntimeFactory(good)).rejects.toThrow("physical module");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

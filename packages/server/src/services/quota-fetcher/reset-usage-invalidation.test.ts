import pino from "pino";
import { expect, test } from "vitest";
import type { ProviderUsage } from "../../server/messages.js";
import { ProviderUsageService } from "./service.js";

test("a pre-reset fetch cannot overwrite the post-reset cache", async () => {
  let release: ((usage: ProviderUsage) => void) | undefined;
  let calls = 0;
  const old = new Promise<ProviderUsage>((resolve) => {
    release = resolve;
  });
  const fresh: ProviderUsage = {
    providerId: "primary",
    displayName: "Primary",
    status: "available",
    planLabel: null,
    windows: [],
  };
  const service = new ProviderUsageService({
    logger: pino({ level: "silent" }),
    fetchers: [
      {
        providerId: "primary",
        displayName: "Primary",
        fetchUsage: async () => {
          calls += 1;
          return calls === 1 ? old : fresh;
        },
      },
    ],
  });
  const pending = service.listUsage();
  service.invalidate();
  expect((await service.listUsage()).providers[0]).toEqual(fresh);
  release?.({ ...fresh, status: "unavailable" });
  await pending;
  expect((await service.listUsage()).providers[0]).toEqual(fresh);
  expect(calls).toBe(2);
});

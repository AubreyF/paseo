import { Command } from "commander";
import { beforeEach, expect, test, vi } from "vitest";
import { runUpdateCommand } from "./update.js";
import type { ScheduleRecord } from "./types.js";

const mocks = vi.hoisted(() => ({
  scheduleInspect: vi.fn(),
  scheduleUpdate: vi.fn(),
  getLastServerInfoMessage: vi.fn(),
  close: vi.fn(),
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  connectScheduleClient: async () => ({ client: mocks, host: "test" }),
}));

const record: ScheduleRecord = {
  id: "schedule",
  name: "Review",
  prompt: "Review work",
  configurationRevision: "saved-revision",
  cadence: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
  target: { type: "new-agent", config: { provider: "codex-secondary", cwd: "/work" } },
  status: "active",
  createdAt: "2026-09-14T00:00:00Z",
  updatedAt: "2026-09-14T00:00:00Z",
  nextRunAt: null,
  lastRunAt: null,
  pausedAt: null,
  expiresAt: null,
  maxRuns: null,
  runs: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getLastServerInfoMessage.mockReturnValue({
    features: { scheduleConfigurationRevision: true },
  });
  mocks.scheduleInspect.mockResolvedValue({ schedule: record, error: null });
  mocks.scheduleUpdate.mockResolvedValue({ schedule: { ...record, name: "Edited" }, error: null });
  mocks.close.mockResolvedValue(undefined);
});

test("schedule CLI update guards the inspected revision", async () => {
  await runUpdateCommand(record.id, { name: "Edited" }, new Command());
  expect(mocks.scheduleUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ expectedConfigurationRevision: "saved-revision", name: "Edited" }),
  );
  expect(mocks.close).toHaveBeenCalledOnce();
});

test("schedule CLI update guards a legacy record on a capable host", async () => {
  mocks.scheduleInspect.mockResolvedValue({
    schedule: { ...record, configurationRevision: undefined },
    error: null,
  });
  await runUpdateCommand(record.id, { name: "Edited" }, new Command());
  expect(mocks.scheduleUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ expectedConfigurationRevision: null }),
  );
});

test("schedule CLI update preserves older host compatibility without discarding a known revision", async () => {
  mocks.getLastServerInfoMessage.mockReturnValue({ features: {} });
  mocks.scheduleInspect.mockResolvedValue({
    schedule: { ...record, configurationRevision: undefined },
    error: null,
  });
  await runUpdateCommand(record.id, { name: "Edited" }, new Command());
  expect(mocks.scheduleUpdate.mock.calls[0]?.[0]).not.toHaveProperty(
    "expectedConfigurationRevision",
  );
  mocks.scheduleInspect.mockResolvedValue({ schedule: record, error: null });
  await runUpdateCommand(record.id, { name: "Edited" }, new Command());
  expect(mocks.scheduleUpdate.mock.calls[1]?.[0]).toHaveProperty(
    "expectedConfigurationRevision",
    "saved-revision",
  );
});

test("schedule CLI update surfaces revision conflicts without retrying or overwriting", async () => {
  mocks.scheduleUpdate.mockResolvedValue({
    schedule: null,
    error: "Schedule configuration changed. Reload it before saving your edits.",
  });
  await expect(
    runUpdateCommand(record.id, { name: "Edited" }, new Command()),
  ).rejects.toMatchObject({
    code: "SCHEDULE_UPDATE_FAILED",
    message: expect.stringContaining("Reload"),
  });
  expect(mocks.scheduleInspect).toHaveBeenCalledOnce();
  expect(mocks.scheduleUpdate).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
});

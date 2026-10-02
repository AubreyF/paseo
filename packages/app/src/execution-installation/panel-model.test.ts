import { expect, test } from "vitest";
import { InstallationPanelModel } from "./panel-model";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";

test("opening or observing a request never approves it", async () => {
  let approvals = 0;
  const job: RestartJob = {
    id: "request",
    revision: "revision",
    target: "host",
    requestedBy: "container-agent",
    reason: "Update",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
    detail: "Approval required",
  };
  const model = new InstallationPanelModel({
    unlock: async () => {},
    listRestarts: async () => [job],
    decide: async () => {
      approvals++;
    },
  });
  model.setPassword("owner-password");
  await model.unlock();
  expect(model.getState().password).toBe("");
  expect(model.getState().visible).toBe(true);
  model.close();
  await model.refresh();
  expect(model.getState().visible).toBe(false);
  model.open();
  expect(approvals).toBe(0);
  await model.decide(job, "approve");
  expect(approvals).toBe(1);
});

test("failed unlock remains visible and can be retried without granting authority", async () => {
  let attempts = 0;
  const model = new InstallationPanelModel({
    unlock: async () => {
      if (++attempts === 1) throw new Error("Incorrect installation password");
    },
    listRestarts: async () => [],
    decide: async () => {
      throw new Error("Unexpected approval");
    },
  });
  model.setPassword("incorrect");
  await model.unlock();
  expect(model.getState()).toMatchObject({
    unlocked: false,
    busy: false,
    visible: true,
    error: "Incorrect installation password",
  });
  model.setPassword("correct");
  await model.unlock();
  expect(model.getState()).toMatchObject({
    unlocked: true,
    busy: false,
    visible: false,
    error: null,
    password: "",
  });
});

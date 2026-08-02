import { expect, test } from "../support/fixtures";
import { openAgentRoute } from "../support/helpers/mock-agent";
import {
  captureHeartbeatEvidence,
  deleteHeartbeat,
  expectHeartbeatDetails,
  expectHeartbeatVisible,
  expectWorkspaceDone,
  expectWorkspaceRunning,
  openHeartbeat,
  openHeartbeatAndSubagentTracks,
  removeSeededSubagent,
  returnToAgentHeartbeat,
  seedAgentWithHeartbeat,
} from "../support/helpers/heartbeats";

test("an agent heartbeat stays visible and keeps its workspace running", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const scenario = await seedAgentWithHeartbeat();

  try {
    await openAgentRoute(page, {
      workspaceId: scenario.workspace.workspaceId,
      agentId: scenario.parent.id,
    });
    await expectWorkspaceRunning(page);
    await openHeartbeatAndSubagentTracks(page);
    await expectHeartbeatVisible(page, scenario.heartbeat);
    await captureHeartbeatEvidence(page, testInfo, "heartbeat-stacked-tracks");

    await openHeartbeat(page, scenario.heartbeat);
    await expectHeartbeatDetails(page, scenario.heartbeat);
    await captureHeartbeatEvidence(page, testInfo, "heartbeat-schedule-details");

    await removeSeededSubagent(scenario);
    await returnToAgentHeartbeat(page);
    await expectWorkspaceRunning(page);
    await page.getByRole("button", { name: "1 heartbeat" }).click();
    await deleteHeartbeat(page, scenario.heartbeat);
    await expect.poll(scenario.readHeartbeatExists, { timeout: 30_000 }).toBe(false);
    await expect(scenario.readAgentStatuses()).resolves.toMatchObject({
      [scenario.parent.id]: "idle",
    });
    await expect.poll(scenario.readWorkspaceStatus, { timeout: 30_000 }).toBe("done");
    await expectWorkspaceDone(page);
    await captureHeartbeatEvidence(page, testInfo, "heartbeat-removed-workspace-done");
  } finally {
    await scenario.cleanup().catch(() => undefined);
  }
});

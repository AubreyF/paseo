import { afterEach, expect, test } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  WSOutboundMessageSchema,
  type CreateAgentRequestMessage,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

let context: DaemonTestContext | undefined;
const peers: WebSocket[] = [];
async function connectLegacyPeer(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  peers.push(socket);
  const frames: SessionOutboundMessage[] = [];
  socket.on("message", (data) => {
    const frame = WSOutboundMessageSchema.parse(JSON.parse(data.toString()));
    if (frame.type === "session") frames.push(frame.message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      clientType: "browser",
      clientId: randomUUID(),
      protocolVersion: 1,
      appVersion: "0.7.2",
    }),
  );
  await expect
    .poll(() => frames.some((m) => m.type === "status" && m.payload.status === "server_info"))
    .toBe(true);
  return {
    createAgent: async (input: Omit<CreateAgentRequestMessage, "type" | "requestId">) => {
      const requestId = randomUUID();
      socket.send(
        JSON.stringify({
          type: "session",
          message: { ...input, type: "create_agent_request", requestId },
        }),
      );
      const response = () =>
        frames.find(
          (m) =>
            m.type === "status" && "requestId" in m.payload && m.payload.requestId === requestId,
        );
      await expect.poll(response).toBeDefined();
      const message = response();
      if (message?.type !== "status") throw new Error("Expected creation status");
      if (message.payload.status === "agent_create_failed") throw new Error(message.payload.error);
      if (message.payload.status !== "agent_created" || !message.payload.agent)
        throw new Error("Expected created agent");
      return message.payload.agent;
    },
  };
}

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  await context?.cleanup();
});

test("concurrent creation retries from different connections create one agent and workspace", async () => {
  context = await createDaemonTestContext();
  const firstClient = await connectLegacyPeer(context.daemon.port);
  const secondClient = await connectLegacyPeer(context.daemon.port);
  const request: Omit<CreateAgentRequestMessage, "type" | "requestId"> = {
    config: { provider: "codex", cwd: context.daemon.paseoHome, modeId: "full-access" },
    initialPrompt: "Say done.",
    clientMessageId: "same-owner-submission",
  };
  const [first, second] = await Promise.all([
    firstClient.createAgent(request),
    secondClient.createAgent(request),
  ]);
  expect(second.id).toBe(first.id);
  expect(second.workspaceId).toBe(first.workspaceId);
  const repeated = await secondClient.createAgent(request);
  expect(repeated.id).toBe(first.id);
  await context.client.waitForFinish(first.id, 10_000);
  const timeline = await context.client.fetchAgentTimeline(first.id, {
    direction: "tail",
    limit: 0,
  });
  const prompts = timeline.entries.filter(({ item }) => item.type === "user_message");
  expect(prompts).toHaveLength(1);
  const agents = await context.client.fetchAgents();
  expect(agents.entries.map((entry) => entry.agent.id)).toEqual([first.id]);
  await expect(
    secondClient.createAgent({ ...request, initialPrompt: "Different task." }),
  ).rejects.toThrow("different agent creation request");
  const distinct = await firstClient.createAgent({
    ...request,
    clientMessageId: "new-submission",
  });
  expect(distinct.id).not.toBe(first.id);
}, 30_000);

test("requests without message IDs keep independent creation behavior", async () => {
  context = await createDaemonTestContext();
  const firstClient = await connectLegacyPeer(context.daemon.port);
  const request: Omit<CreateAgentRequestMessage, "type" | "requestId"> = {
    config: { provider: "codex", cwd: context.daemon.paseoHome, modeId: "full-access" },
  };
  const first = await firstClient.createAgent(request);
  const second = await firstClient.createAgent(request);
  expect(second.id).not.toBe(first.id);
});

#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

if (process.argv.includes("--version")) {
  process.stdout.write("workspace-runtime-fixture 1.0.0\n");
  process.exit(0);
}

class WorkspaceRuntimeFixtureAgent {
  constructor(connection) {
    this.connection = connection;
    this.sessions = new Map();
  }

  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    };
  }

  async newSession(params) {
    const sessionId = `fixture-session-${this.sessions.size + 1}`;
    this.sessions.set(sessionId, { cwd: params.cwd });
    return {
      sessionId,
      models: {
        availableModels: [{ modelId: "fixture-model", name: "Fixture Model" }],
        currentModelId: "fixture-model",
      },
    };
  }

  async authenticate() {
    return {};
  }

  async setSessionMode() {
    return {};
  }

  async unstable_setSessionModel() {
    return {};
  }

  async cancel() {}

  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown fixture session: ${params.sessionId}`);
    const text = params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    await writeFile(path.join(session.cwd, "stdio-agent-output.txt"), `${text}\n`);
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `fixture completed: ${text}` },
      },
    });
    return { stopReason: "end_turn" };
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = new AgentSideConnection(
  (agentConnection) => new WorkspaceRuntimeFixtureAgent(agentConnection),
  stream,
);
await connection.closed;

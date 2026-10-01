import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../../atomic-file.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  agentId: z.string().nullable(),
});

export class AgentCreationRequestError extends Error {}

interface CreationRequest {
  home: string;
  principal: string;
  messageId: string;
  payload: unknown;
  create: (recordCreated: (agentId: string) => Promise<void>) => Promise<string>;
}

interface PendingCreation {
  fingerprint: string;
  result: Promise<string>;
}

// Sessions share this gate. A connection-local lock cannot prevent reconnect retries.
const pending = new Map<string, PendingCreation>();

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function verifyFingerprint(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new AgentCreationRequestError(
      "This message ID was already used for a different agent creation request.",
    );
  }
}

async function createOnce(
  input: CreationRequest,
  file: string,
  fingerprint: string,
): Promise<string> {
  try {
    const receipt = ReceiptSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
    verifyFingerprint(receipt.fingerprint, fingerprint);
    if (receipt.agentId === null) {
      throw new AgentCreationRequestError(
        "Agent creation was interrupted. Inspect the existing task before submitting a new request.",
      );
    }
    return receipt.agentId;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  await writeJsonFileAtomic(file, { fingerprint, agentId: null });
  let created = false;
  try {
    return await input.create(async (agentId) => {
      // Retain the reservation even if saving the created ID fails: a retry must
      // never launch a second agent after the first has already been allocated.
      created = true;
      await writeJsonFileAtomic(file, { fingerprint, agentId });
    });
  } catch (error) {
    if (!created) await fs.rm(file, { force: true });
    throw error;
  }
}

export async function createAgentForMessage(input: CreationRequest): Promise<string> {
  const key = digest([input.principal, input.messageId]);
  const file = path.join(input.home, "agent-creations", `${key}.json`);
  const fingerprint = digest(input.payload);
  const existing = pending.get(file);
  if (existing) {
    verifyFingerprint(existing.fingerprint, fingerprint);
    return existing.result;
  }
  const result = createOnce(input, file, fingerprint);
  pending.set(file, { fingerprint, result });
  try {
    return await result;
  } finally {
    pending.delete(file);
  }
}

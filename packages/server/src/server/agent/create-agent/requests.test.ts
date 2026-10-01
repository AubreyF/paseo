import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createAgentForMessage } from "./requests.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "agent-creation-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function request() {
  return { home, principal: "owner", messageId: "submission", payload: { prompt: "Do the task." } };
}

test("a completed request is replayed from its receipt without allocating another agent", async () => {
  let creations = 0;
  async function create(recordCreated: (id: string) => Promise<void>) {
    creations++;
    await recordCreated("first-agent");
    return "first-agent";
  }
  expect(await createAgentForMessage({ ...request(), create })).toBe("first-agent");
  expect(await createAgentForMessage({ ...request(), create })).toBe("first-agent");
  expect(creations).toBe(1);
});

test("failure before allocation permits a retry", async () => {
  await expect(
    createAgentForMessage({
      ...request(),
      create: async () => {
        throw new Error("Provider unavailable");
      },
    }),
  ).rejects.toThrow("Provider unavailable");
  expect(
    await createAgentForMessage({
      ...request(),
      create: async (recordCreated) => {
        await recordCreated("recovered-agent");
        return "recovered-agent";
      },
    }),
  ).toBe("recovered-agent");
});

test("failure after allocation retains the existing agent instead of repeating its prompt", async () => {
  await expect(
    createAgentForMessage({
      ...request(),
      create: async (recordCreated) => {
        await recordCreated("allocated-agent");
        throw new Error("Prompt failed");
      },
    }),
  ).rejects.toThrow("Prompt failed");
  expect(
    await createAgentForMessage({
      ...request(),
      create: async () => {
        throw new Error("Must not create another agent");
      },
    }),
  ).toBe("allocated-agent");
});

test("different principals may use the same client message ID", async () => {
  for (const principal of ["first-owner", "second-owner"]) {
    expect(
      await createAgentForMessage({
        ...request(),
        principal,
        create: async (recordCreated) => {
          await recordCreated(principal);
          return principal;
        },
      }),
    ).toBe(principal);
  }
});

test("interrupted pending receipts fail closed", async () => {
  const key = createHash("sha256")
    .update(JSON.stringify(["owner", "submission"]))
    .digest("hex");
  const fingerprint = createHash("sha256").update(JSON.stringify(request().payload)).digest("hex");
  await mkdir(path.join(home, "agent-creations"));
  await writeFile(
    path.join(home, "agent-creations", `${key}.json`),
    JSON.stringify({ fingerprint, agentId: null }),
  );
  await expect(
    createAgentForMessage({
      ...request(),
      create: async () => {
        throw new Error("Must not allocate");
      },
    }),
  ).rejects.toThrow("Agent creation was interrupted");
});

test("concurrent requests with conflicting contents fail without another allocation", async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let allocations = 0;
  const first = createAgentForMessage({
    ...request(),
    create: async (recordCreated) => {
      allocations++;
      await ready;
      await recordCreated("original");
      return "original";
    },
  });
  try {
    await expect(
      createAgentForMessage({
        ...request(),
        payload: { prompt: "Another task" },
        create: async () => {
          allocations++;
          return "duplicate";
        },
      }),
    ).rejects.toThrow("different agent creation request");
  } finally {
    release();
  }
  expect(await first).toBe("original");
  expect(allocations).toBe(1);
});

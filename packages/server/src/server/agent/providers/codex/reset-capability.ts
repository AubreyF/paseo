import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { execCommand } from "../../../../utils/spawn.js";
import {
  createProviderEnvSpec,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";

const SchemaNode = z.object({
  type: z.string().optional(),
  required: z.array(z.string()).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});
const RequestSchema = z.object({
  oneOf: z.array(SchemaNode),
  definitions: z.record(z.string(), SchemaNode),
});

/** Require the installed binary to advertise an idempotent mutation contract. */
export function supportsResetRedemption(input: unknown): boolean {
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) return false;
  return parsed.data.oneOf.some((request) => {
    const method = z.object({ enum: z.array(z.string()) }).safeParse(request.properties?.method);
    if (!method.success || !method.data.enum.includes("account/rateLimitResetCredit/consume"))
      return false;
    if (!request.required?.includes("params")) return false;
    const params = z.object({ $ref: z.string() }).safeParse(request.properties?.params);
    if (!params.success || !params.data.$ref.startsWith("#/definitions/")) return false;
    const definition = parsed.data.definitions[params.data.$ref.slice("#/definitions/".length)];
    if (!definition?.required?.includes("idempotencyKey")) return false;
    const key = SchemaNode.safeParse(definition.properties?.idempotencyKey);
    return key.success && key.data.type === "string";
  });
}

export async function probeResetRedemption(
  launch: { command: string; args: string[] },
  runtimeSettings?: ProviderRuntimeSettings,
): Promise<boolean> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-reset-capability-"));
  try {
    await execCommand(
      launch.command,
      [...launch.args, "app-server", "generate-json-schema", "--out", directory],
      {
        ...createProviderEnvSpec({ runtimeSettings }),
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return supportsResetRedemption(
      JSON.parse(await fs.readFile(path.join(directory, "ClientRequest.json"), "utf8")),
    );
  } catch {
    // Reading counts still works when the binary cannot prove mutation support.
    return false;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

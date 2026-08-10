import { z } from "zod";

export const CommandRuntimeStateSchema = z.object({
  workspaceId: z.string(),
  root: z.string(),
  revision: z.string(),
  executionDomainId: z.string(),
  lifecycle: z.enum(["ready", "paused"]),
});

export const CommandRuntimeInspectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing") }),
  z.object({ status: z.literal("paused"), state: CommandRuntimeStateSchema }),
  z.object({ status: z.literal("ready"), state: CommandRuntimeStateSchema }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);

export const CommandRuntimeLifecycleResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("state"),
    protocolVersion: z.literal(1),
    state: CommandRuntimeStateSchema,
  }),
  z.object({
    type: z.literal("inspection"),
    protocolVersion: z.literal(1),
    inspection: CommandRuntimeInspectionSchema,
  }),
  z.object({ type: z.literal("ok"), protocolVersion: z.literal(1) }),
]);

export const CommandRuntimeDescribeResponseSchema = z.object({
  protocolVersion: z.literal(1),
  modes: z.array(z.enum(["pipes"])),
});

import { z } from "zod";

export const CommandRuntimeStateSchema = z.object({
  workspaceId: z.string(),
  root: z.string(),
  revision: z.string(),
  executionDomainId: z.string(),
  lifecycle: z.enum(["ready", "paused"]),
  lifecycleEnvironment: z.record(z.string(), z.string()).optional(),
});

export const CommandRuntimePlacementSchema = z.object({
  cwd: z.string(),
  hostVisiblePath: z.string().optional(),
});

export const CommandRuntimeInspectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("missing") }),
  z.object({
    status: z.literal("paused"),
    state: CommandRuntimeStateSchema,
    // COMPAT(command-runtime-placement): older v1 runtimes parse, then fail closed at selection.
    placement: CommandRuntimePlacementSchema.optional(),
  }),
  z.object({
    status: z.literal("ready"),
    state: CommandRuntimeStateSchema,
    // COMPAT(command-runtime-placement): older v1 runtimes parse, then fail closed at selection.
    placement: CommandRuntimePlacementSchema.optional(),
  }),
  z.object({ status: z.literal("error"), message: z.string() }),
]);

export const CommandRuntimeLifecycleResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("state"),
    protocolVersion: z.literal(1),
    state: CommandRuntimeStateSchema,
    // COMPAT(command-runtime-placement): older v1 runtimes parse, then fail closed at selection.
    placement: CommandRuntimePlacementSchema.optional(),
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
  modes: z.array(z.enum(["pipes", "pty"])),
  reconcile: z.boolean().optional().default(false),
});

export const CommandRuntimePtyEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("eof"), protocolVersion: z.literal(1) }),
  z.object({
    type: z.literal("resized"),
    protocolVersion: z.literal(1),
    id: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("exit"),
    protocolVersion: z.literal(1),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
  }),
  z.object({
    type: z.literal("error"),
    protocolVersion: z.literal(1),
    message: z.string(),
  }),
]);

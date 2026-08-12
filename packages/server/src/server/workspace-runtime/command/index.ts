import type { WorkspaceRuntimeDriver } from "../drivers/index.js";
import { createCommandRuntime } from "./internal/command-runtime.js";

export interface CommandRuntimeAdapterConfig {
  command: readonly [string, ...string[]];
  label?: string;
  options?: Readonly<Record<string, unknown>>;
  helperCommand?: readonly [string, ...string[]];
}

export function createCommandRuntimeAdapter(
  runtimeId: string,
  config: CommandRuntimeAdapterConfig,
): WorkspaceRuntimeDriver {
  return createCommandRuntime(runtimeId, config);
}

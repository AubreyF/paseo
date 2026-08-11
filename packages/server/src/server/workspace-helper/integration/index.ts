import type { Readable, Writable } from "node:stream";

import type { WorkspaceFiles } from "../index.js";
import { createClient } from "../internal/client.js";

export interface WorkspaceHelperProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal?: NodeJS.Signals): void;
}

export interface WorkspaceFilesOwner {
  files: WorkspaceFiles;
  resolveCommand(command: string): Promise<string | null>;
  verify(): Promise<void>;
  close(): Promise<void>;
}

/** @package Parent integration SPI. Normal callers consume WorkspaceFiles from the public module. */
export function bindWorkspaceHelper(options: {
  root: string;
  allowAbsolutePaths?: boolean;
  command: readonly [string, ...string[]];
  launch(argv: readonly [string, ...string[]]): Promise<WorkspaceHelperProcess>;
}): WorkspaceFilesOwner {
  return createClient(options);
}

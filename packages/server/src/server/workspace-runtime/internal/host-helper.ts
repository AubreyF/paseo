import { fileURLToPath } from "node:url";

export const hostWorkspaceHelperCommand = [
  process.execPath,
  fileURLToPath(new URL("../../workspace-helper/executable.mjs", import.meta.url)),
] as const;

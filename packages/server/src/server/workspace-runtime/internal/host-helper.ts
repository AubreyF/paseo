import { fileURLToPath } from "node:url";

import { buildSelfNodeCommand } from "../../paseo-env.js";

const executable = fileURLToPath(new URL("../../workspace-helper/executable.mjs", import.meta.url));
const launch = buildSelfNodeCommand([executable]);

export const hostWorkspaceHelper = {
  command: [launch.command, ...launch.args] as readonly [string, ...string[]],
  env: launch.env,
};

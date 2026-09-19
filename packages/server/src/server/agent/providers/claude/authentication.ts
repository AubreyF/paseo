import { z } from "zod";
import { execCommand } from "../../../../utils/spawn.js";
import {
  createProviderEnvSpec,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";

const AuthStatusSchema = z.object({ loggedIn: z.boolean() });
const SignedOutCommandSchema = z.object({ code: z.literal(1), stdout: z.string() });

export class ClaudeAuthenticationError extends Error {
  constructor(readonly code: "SIGN_IN_REQUIRED" | "CHECK_FAILED") {
    super(
      code === "SIGN_IN_REQUIRED"
        ? "Claude Code is not signed in. Run claude auth login in this host's container, then refresh the provider."
        : "Could not verify Claude Code authentication. Run claude auth status in this host's container, then refresh the provider.",
    );
  }
}

interface AuthenticationCheck {
  executable: string;
  args: string[];
  runtimeSettings?: ProviderRuntimeSettings;
  signal?: AbortSignal;
  run?: typeof execCommand;
}

/** Use the CLI's effective auth configuration, including API keys and cloud providers. */
export async function requireClaudeAuthentication(input: AuthenticationCheck): Promise<void> {
  const run = input.run ?? execCommand;
  let stdout: string;
  let commandSucceeded = true;
  try {
    const result = await run(input.executable, [...input.args, "auth", "status"], {
      ...createProviderEnvSpec({ runtimeSettings: input.runtimeSettings }),
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      signal: input.signal,
    });
    stdout = result.stdout;
  } catch (error) {
    // The CLI returns JSON with exit status 1 when signed out.
    const signedOut = SignedOutCommandSchema.safeParse(error);
    if (!signedOut.success) throw new ClaudeAuthenticationError("CHECK_FAILED");
    stdout = signedOut.data.stdout;
    commandSucceeded = false;
  }

  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new ClaudeAuthenticationError("CHECK_FAILED");
  }
  const status = AuthStatusSchema.safeParse(value);
  if (!status.success) throw new ClaudeAuthenticationError("CHECK_FAILED");
  if (!status.data.loggedIn) throw new ClaudeAuthenticationError("SIGN_IN_REQUIRED");
  if (!commandSucceeded) throw new ClaudeAuthenticationError("CHECK_FAILED");
}

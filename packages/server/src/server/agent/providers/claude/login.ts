import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import stripAnsi from "strip-ansi";
import type {
  ProviderLoginChallenge,
  ProviderLoginSession,
} from "../../../../services/provider-login/session.js";
import { spawnProcess } from "../../../../utils/spawn.js";
import {
  createProviderEnvSpec,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { requireClaudeAuthentication } from "./authentication.js";

interface ClaudeLoginOptions {
  executable: string;
  args: string[];
  scope: string;
  runtimeSettings?: ProviderRuntimeSettings;
}

/** The official CLI owns OAuth state, token exchange, refresh and credential storage. */
export class ClaudeLoginSession implements ProviderLoginSession {
  readonly scope: string;
  private process: ChildProcess | null = null;
  private closed: Promise<void> = Promise.resolve();
  private stopping = false;
  private submitted = false;
  private challengeReady = false;

  constructor(private readonly options: ClaudeLoginOptions) {
    this.scope = options.scope;
  }

  async start(onComplete: (success: boolean) => void): Promise<ProviderLoginChallenge> {
    if (this.stopping || this.process) throw new Error("Sign-in is no longer available.");
    await mkdir(this.scope, { recursive: true, mode: 0o700 });
    if (this.stopping) throw new Error("Sign-in was cancelled.");
    const child = spawnProcess(
      this.options.executable,
      [...this.options.args, "auth", "login", "--claudeai"],
      {
        ...createProviderEnvSpec({ runtimeSettings: this.options.runtimeSettings }),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.process = child;
    this.closed = new Promise((resolve) => child.once("close", () => resolve()));
    return new Promise((resolve, reject) => {
      let output = "";
      const fail = () =>
        reject(
          new Error("Could not start Claude sign-in. Check the CLI installation and try again."),
        );
      const timeout = setTimeout(() => {
        fail();
        void this.dispose();
      }, 30_000);
      timeout.unref();
      const read = (chunk: Buffer) => {
        if (this.challengeReady || this.stopping) return;
        output += chunk.toString("utf8");
        if (output.length > 64 * 1024) {
          fail();
          void this.dispose();
          return;
        }
        const match = stripAnsi(output).match(
          /https:\/\/(?:claude\.ai\/oauth|claude\.com\/cai\/oauth)\/authorize\?[^\s]+(?=\s)/,
        );
        if (!match) return;
        const url = new URL(match[0]);

        this.challengeReady = true;
        output = "";
        clearTimeout(timeout);
        resolve({ verificationUrl: url.href, userCode: "", inputRequired: true });
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.stdin?.on("error", () => {
        if (!this.stopping) {
          onComplete(false);
          void this.dispose();
        }
      });
      child.once("error", () => {
        clearTimeout(timeout);
        fail();
        if (this.challengeReady && !this.stopping) onComplete(false);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (!this.challengeReady) fail();
        if (this.stopping) return;
        if (code !== 0) {
          onComplete(false);
          return;
        }
        void requireClaudeAuthentication(this.options).then(
          () => {
            if (!this.stopping) onComplete(true);
            return undefined;
          },
          () => {
            if (!this.stopping) onComplete(false);
          },
        );
      });
    });
  }

  async submitCode(code: string): Promise<void> {
    if (!code || code.length > 4096 || !/^[!-~]+$/.test(code))
      throw new Error("Paste the complete sign-in code without spaces or line breaks.");
    const child = this.process;
    if (
      !this.challengeReady ||
      this.stopping ||
      this.submitted ||
      !child?.stdin ||
      child.exitCode !== null
    )
      throw new Error("This sign-in attempt is no longer accepting a code. Refresh its status.");
    const stdin = child.stdin;
    this.submitted = true;
    await new Promise<void>((resolve, reject) =>
      stdin.write(`${code}\n`, (error) => {
        if (error) reject(new Error("Could not submit the sign-in code. Start sign-in again."));
        else resolve();
      }),
    );
  }

  async readAccountLabel(): Promise<string | null> {
    return null;
  }
  cancel(): Promise<void> {
    return this.dispose();
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    const child = this.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 1000);
    force.unref();
    await this.closed;
    clearTimeout(force);
  }
}

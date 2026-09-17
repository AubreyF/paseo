import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { spawnProcess } from "../../../utils/spawn.js";
import {
  QuotaConstructionCleanupError,
  type QuotaGovernedSessionInput,
} from "../agent-sdk-types.js";

const Identity = z
  .object({
    version: z.literal(1),
    executionId: z.string().uuid(),
    authenticationGeneration: z.string().min(1).max(256),
    attemptId: z.string().min(1).max(256),
    ownershipGeneration: z.number().int().positive(),
    nonce: z.string().uuid(),
  })
  .strict();
const Receipt = z
  .object({
    identity: Identity,
    settled: z.literal(true),
    reason: z.enum([
      "startup_failure",
      "native_exit",
      "signal",
      "control_timeout",
      "controller_eof",
      "freeze",
    ]),
  })
  .strict();

interface CustodyOptions {
  /** Existing owner-only coordinator directory, outside all worker mounts. */
  journalRoot: string;
  executable: string;
  pythonExecutable: string;
  cwd: string;
  /** Complete trusted environment. No inherited host environment or task overlays. */
  env: Record<string, string>;
  identity: Omit<z.infer<typeof Identity>, "version" | "nonce">;
}

async function protectedDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    (info.mode & 0o777) !== 0o700 ||
    info.uid !== process.getuid?.() ||
    (await realpath(directory)) !== directory
  )
    throw new Error("Custody journal requires an owner-only physical directory.");
}

/** One native launch only. Unknown settlement never releases execution capacity. */
export class LinuxQuotaProcessCustody implements NonNullable<
  QuotaGovernedSessionInput["processCustody"]
> {
  private child?: ChildProcessWithoutNullStreams;
  private control?: Writable;
  private heartbeat?: ReturnType<typeof setInterval>;
  private exit?: Promise<void>;
  private started = false;

  private constructor(
    private readonly options: CustodyOptions,
    readonly directory: string,
    readonly identity: Readonly<z.infer<typeof Identity>>,
  ) {}

  static async create(options: CustodyOptions): Promise<LinuxQuotaProcessCustody> {
    if (process.platform !== "linux") throw new Error("Native process custody requires Linux.");
    for (const path of [
      options.journalRoot,
      options.executable,
      options.pythonExecutable,
      options.cwd,
    ]) {
      if (!isAbsolute(path)) throw new Error("Custody paths must be absolute.");
    }
    const permitted = new Set([
      "HOME",
      "CODEX_HOME",
      "PATH",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ]);
    if (Object.keys(options.env).some((key) => !permitted.has(key))) {
      throw new Error("Unapproved governed process environment variable.");
    }
    await protectedDirectory(options.journalRoot);
    const identity = Object.freeze(
      Identity.parse({ ...options.identity, version: 1, nonce: randomUUID() }),
    );
    const directory = await mkdtemp(join(options.journalRoot, "execution-"));
    const intent = await open(join(directory, "intent.json"), "wx", 0o600);
    try {
      await intent.writeFile(JSON.stringify(identity));
      await intent.sync();
    } finally {
      await intent.close();
    }
    for (const path of [directory, options.journalRoot]) {
      const descriptor = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await descriptor.sync();
      } finally {
        await descriptor.close();
      }
    }
    return new LinuxQuotaProcessCustody(structuredClone(options), directory, identity);
  }

  async spawn(command: string, args: string[]): Promise<ChildProcessWithoutNullStreams> {
    if (this.started) throw new Error("Custody cannot launch another native process.");
    if (command !== this.options.executable)
      throw new Error("Governed executable differs from its pinned launch.");
    await protectedDirectory(this.directory);
    this.started = true;
    const child = spawnProcess(
      this.options.pythonExecutable,
      [
        "-I",
        fileURLToPath(new URL("./linux-custody.py", import.meta.url)),
        this.directory,
        command,
        ...args,
      ],
      {
        cwd: this.options.cwd,
        baseEnv: this.options.env,
        envMode: "internal",
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
        detached: true,
        shell: false,
      },
    ) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.control = child.stdio[3] as Writable;
    this.control.on("error", () => {
      /* Exit and receipt, not pipe errors, determine settlement. */
    });
    this.exit = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    // Keep early launch failures observed while the startup handshake is pending.
    void this.exit.catch(() => {});
    const status = child.stdio[4] as Readable;
    try {
      await new Promise<void>((resolve, reject) => {
        let received = "";
        const timer = setTimeout(() => finish(new Error("Custody startup timed out.")), 10_000);
        const onData = (data: Buffer) => {
          received += data.toString();
          if (received === "ready\n") finish();
          else if (received.length >= 6) finish(new Error("Invalid custody handshake."));
        };
        const onExit = () => finish(new Error("Custody exited before startup."));
        const finish = (error?: Error) => {
          clearTimeout(timer);
          status.off("data", onData);
          child.off("exit", onExit);
          child.off("error", finish);
          if (error) {
            this.control?.end("f");
            reject(error);
          } else resolve();
        };
        status.on("data", onData);
        child.once("exit", onExit);
        child.once("error", finish);
      });
    } catch (error) {
      try {
        await this.settle(child);
      } catch {
        throw new QuotaConstructionCleanupError(() => this.settle(child));
      }
      throw error;
    }
    if (child.exitCode === null && child.signalCode === null) {
      this.heartbeat = setInterval(() => {
        this.control?.write("t");
      }, 5_000);
      this.heartbeat.unref();
      child.once("exit", () => clearInterval(this.heartbeat));
    }
    return child;
  }

  async settle(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child !== this.child || !this.exit) throw new Error("Custody process identity mismatch.");
    clearInterval(this.heartbeat);
    if (!this.control?.writableEnded) this.control?.end("f");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Descendant settlement timed out; custody retained.")),
            8_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await LinuxQuotaProcessCustody.readSettlement(this.directory, this.identity);
  }

  static async readSettlement(
    directory: string,
    identity: z.infer<typeof Identity>,
  ): Promise<void> {
    await protectedDirectory(directory);
    Identity.parse(identity);
    const file = await open(
      join(directory, "receipt.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > 4096 ||
        (info.mode & 0o777) !== 0o600 ||
        info.uid !== process.getuid?.()
      ) {
        throw new Error("Unprotected custody receipt.");
      }
      const receipt = Receipt.parse(JSON.parse(await file.readFile("utf8")));
      if (!isDeepStrictEqual(receipt.identity, identity))
        throw new Error("Custody receipt identity mismatch.");
    } finally {
      await file.close();
    }
  }
}

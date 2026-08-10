import type {
  CreateWorkspaceInput,
  WorkspaceProcess,
  WorkspaceProcessInput,
  WorkspaceRuntimeRecordStore,
  WorkspaceRuntimeService,
  WorkspaceTerminal,
  WorkspaceTerminalInput,
} from "../index.js";
import type {
  WorkspaceDriverProcess,
  WorkspaceDriverCreateInput,
  WorkspaceRuntimeDriver,
} from "../drivers/index.js";

const gracefulStopMilliseconds = 1_000;
const forcedStopMilliseconds = 1_000;

export function createService(
  drivers: readonly WorkspaceRuntimeDriver[],
  records: WorkspaceRuntimeRecordStore,
): WorkspaceRuntimeService {
  const driversById = new Map(drivers.map((driver) => [driver.id, driver]));
  const processesByWorkspaceId = new Map<string, Set<WorkspaceDriverProcess>>();
  const workspaceTails = new Map<string, Promise<void>>();

  function requireRegistered(runtimeId: string): WorkspaceRuntimeDriver {
    const driver = driversById.get(runtimeId);
    if (!driver) throw new Error(`Workspace runtime is not registered: ${runtimeId}`);
    return driver;
  }

  async function resolve(workspaceId: string): Promise<WorkspaceRuntimeDriver> {
    const runtimeId = await records.resolveRuntimeId(workspaceId);
    if (!runtimeId) throw new Error(`Workspace runtime is not selected: ${workspaceId}`);
    return requireRegistered(runtimeId);
  }

  async function runWithDriver(
    driver: WorkspaceRuntimeDriver,
    input: WorkspaceProcessInput,
  ): Promise<WorkspaceProcess> {
    validateRelativeCwd(input.cwd);
    const inspection = await driver.inspect(input.workspaceId);
    if (inspection.status !== "ready") {
      throw new Error(`Workspace runtime is ${inspection.status}: ${input.workspaceId}`);
    }
    const runtimeProcess = await driver.spawn({ ...input, stdio: { kind: "pipes" } });
    if (runtimeProcess.kind !== "pipes") {
      throw new Error(`Workspace runtime returned PTY mode for a pipe launch: ${driver.id}`);
    }
    trackProcess(input.workspaceId, runtimeProcess);
    return runtimeProcess;
  }

  async function openTerminalWithDriver(
    driver: WorkspaceRuntimeDriver,
    input: WorkspaceTerminalInput,
  ): Promise<WorkspaceTerminal> {
    validateRelativeCwd(input.cwd);
    const inspection = await driver.inspect(input.workspaceId);
    if (inspection.status !== "ready") {
      throw new Error(`Workspace runtime is ${inspection.status}: ${input.workspaceId}`);
    }
    const runtimeProcess = await driver.spawn({
      ...input,
      stdio: { kind: "pty", rows: input.rows, cols: input.cols, term: input.term },
    });
    if (runtimeProcess.kind !== "pty") {
      throw new Error(`Workspace runtime does not support PTY mode: ${driver.id}`);
    }
    trackProcess(input.workspaceId, runtimeProcess);
    return runtimeProcess;
  }

  return {
    async create(input) {
      return sequence(input.workspaceId, async () => {
        const selectedRuntimeId = await records.resolveRuntimeId(input.workspaceId);
        if (selectedRuntimeId && selectedRuntimeId !== input.runtimeId) {
          throw new Error(
            `Workspace runtime is already selected as ${selectedRuntimeId}: ${input.workspaceId}`,
          );
        }
        const driver = requireRegistered(input.runtimeId);
        const before = await driver.inspect(input.workspaceId);
        let ownsNewResource = false;
        try {
          await driver.create(toDriverCreateInput(input));
          ownsNewResource = before.status === "missing";
          if (ownsNewResource) {
            for (const command of input.setup ?? []) {
              const process = await runWithDriver(driver, {
                workspaceId: input.workspaceId,
                ...command,
                purpose: { kind: "setup" },
              });
              process.stdin.end();
              const [, , exit] = await Promise.all([
                drain(process.stdout),
                drain(process.stderr),
                process.exited,
              ]);
              if (exit.code !== 0 || exit.signal !== null) {
                throw new Error(`Workspace setup failed: ${exit.code ?? exit.signal}`);
              }
            }
          }
          await records.persistRuntimeId(input.workspaceId, input.runtimeId);
          return { workspaceId: input.workspaceId, runtimeId: input.runtimeId };
        } catch (error) {
          if (ownsNewResource) {
            try {
              await stopProcesses(input.workspaceId);
              await driver.destroy(input.workspaceId);
            } catch (cleanupError) {
              throw new Error(`Workspace creation failed before cleanup: ${String(error)}`, {
                cause: cleanupError,
              });
            }
          }
          throw error;
        }
      });
    },
    async run(input) {
      return sequence(input.workspaceId, async () =>
        runWithDriver(await resolve(input.workspaceId), input),
      );
    },
    async openTerminal(input) {
      return sequence(input.workspaceId, async () =>
        openTerminalWithDriver(await resolve(input.workspaceId), input),
      );
    },
    async pause(workspaceId) {
      await sequence(workspaceId, async () => {
        const driver = await resolve(workspaceId);
        await stopProcesses(workspaceId);
        await driver.pause(workspaceId);
      });
    },
    async resume(workspaceId) {
      await sequence(workspaceId, async () => {
        await (await resolve(workspaceId)).resume(workspaceId);
      });
    },
    async destroy(workspaceId) {
      await sequence(workspaceId, async () => {
        const driver = await resolve(workspaceId);
        await stopProcesses(workspaceId);
        await driver.destroy(workspaceId);
      });
    },
  };

  async function sequence<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = workspaceTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.then(() => gate);
    workspaceTails.set(workspaceId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (workspaceTails.get(workspaceId) === tail) workspaceTails.delete(workspaceId);
    }
  }

  function trackProcess(workspaceId: string, runtimeProcess: WorkspaceDriverProcess): void {
    const processes = processesByWorkspaceId.get(workspaceId) ?? new Set();
    processes.add(runtimeProcess);
    processesByWorkspaceId.set(workspaceId, processes);
    void runtimeProcess.exited.then(
      () => forgetProcess(workspaceId, runtimeProcess),
      () => forgetProcess(workspaceId, runtimeProcess),
    );
  }

  function forgetProcess(workspaceId: string, runtimeProcess: WorkspaceDriverProcess): void {
    const processes = processesByWorkspaceId.get(workspaceId);
    processes?.delete(runtimeProcess);
    if (processes?.size === 0) processesByWorkspaceId.delete(workspaceId);
  }

  async function stopProcesses(workspaceId: string): Promise<void> {
    const processes = [...(processesByWorkspaceId.get(workspaceId) ?? [])];
    for (const runtimeProcess of processes) runtimeProcess.kill("SIGTERM");
    const graceful = await waitForAll(processes, gracefulStopMilliseconds);
    if (graceful) return;
    for (const runtimeProcess of processes) runtimeProcess.kill("SIGKILL");
    if (!(await waitForAll(processes, forcedStopMilliseconds))) {
      throw new Error(`Workspace processes did not stop: ${workspaceId}`);
    }
  }
}

async function drain(stream: NodeJS.ReadableStream): Promise<void> {
  for await (const _chunk of stream) {
    // Setup output is consumed here so a verbose command cannot block on a full pipe.
  }
}

function validateRelativeCwd(cwd: string | undefined): void {
  if (cwd === undefined) return;
  const parts = cwd.split(/[\\/]/u);
  if (cwd.startsWith("/") || cwd.includes("\\") || parts.includes("..")) {
    throw new Error(`Workspace cwd must stay within the runtime root: ${cwd}`);
  }
}

function toDriverCreateInput(input: CreateWorkspaceInput): WorkspaceDriverCreateInput {
  return {
    workspaceId: input.workspaceId,
    project: {
      projectId: input.project.id,
      source: input.project.source,
    },
    placement: input.placement,
  };
}

async function waitForAll(
  processes: readonly WorkspaceDriverProcess[],
  timeoutMilliseconds: number,
): Promise<boolean> {
  if (processes.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMilliseconds);
  });
  const exited = Promise.allSettled(processes.map((runtimeProcess) => runtimeProcess.exited)).then(
    () => true as const,
  );
  const result = await Promise.race([exited, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

import nodePath from "node:path";

import type { BoundWorkspaceRuntime } from "../index.js";
import type { WorkspaceRuntimeDriver, WorkspaceDriverProcess } from "../drivers/index.js";
import type { WorkspaceFilesOwner } from "../../workspace-helper/integration/index.js";
import { bindWorkspaceHelper } from "../../workspace-helper/integration/index.js";
import type { WorkspaceFilesSubscription } from "../../workspace-helper/index.js";
import { registerGitCommonObservationCapability } from "./internal/capability.js";

const MAX_DISCOVERY_OUTPUT_BYTES = 64 * 1024;

interface LogicalObservation {
  workspaceId: string;
  driver: WorkspaceRuntimeDriver;
  listener: () => void;
  scope: SharedScope;
}

interface PhysicalOwner {
  workspaceId: string;
  client: WorkspaceFilesOwner;
  bindings: Map<LogicalObservation, WorkspaceFilesSubscription>;
}

interface SharedScope {
  key: string;
  root: string;
  observations: Set<LogicalObservation>;
  owner: PhysicalOwner | null;
  tail: Promise<void>;
}

export interface ObservationRebindTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface GitCommonObservationCoordinator {
  bind(runtime: BoundWorkspaceRuntime, workspaceId: string, driver: WorkspaceRuntimeDriver): void;
  pause(workspaceId: string): Promise<void>;
  stageResume(workspaceId: string): Promise<ObservationRebindTransaction>;
  destroy(workspaceId: string): Promise<void>;
}

export function createGitCommonObservationCoordinator(options: {
  launchHelper(
    driver: WorkspaceRuntimeDriver,
    workspaceId: string,
    argv: readonly [string, ...string[]],
  ): Promise<WorkspaceDriverProcess>;
  runGit(
    driver: WorkspaceRuntimeDriver,
    workspaceId: string,
    argv: readonly [string, ...string[]],
  ): Promise<WorkspaceDriverProcess>;
  isUnavailable(workspaceId: string): boolean;
}): GitCommonObservationCoordinator {
  const scopes = new Map<string, SharedScope>();

  return {
    bind(runtime, workspaceId, driver) {
      registerGitCommonObservationCapability(runtime, {
        observe: (listener) => observe(workspaceId, driver, listener),
      });
    },
    async pause(workspaceId) {
      for (const scope of relevantScopes(workspaceId)) {
        await withScope(scope, () => pauseInScope(scope, workspaceId));
      }
    },
    async stageResume(workspaceId) {
      const locked = await lockScopes(relevantScopes(workspaceId));
      const transactions: ObservationRebindTransaction[] = [];
      try {
        for (const scope of locked.scopes) {
          transactions.push(await stageScopeResume(scope, workspaceId));
        }
      } catch (error) {
        await Promise.allSettled(transactions.map((transaction) => transaction.rollback()));
        locked.release();
        throw error;
      }
      return finishWithRelease(combineTransactions(transactions), locked.release);
    },
    async destroy(workspaceId) {
      for (const scope of relevantScopes(workspaceId)) {
        await withScope(scope, async () => {
          await pauseInScope(scope, workspaceId);
          const owned = [...scope.observations].filter(
            (observation) => observation.workspaceId === workspaceId,
          );
          for (const observation of owned) removeLogicalObservation(observation);
          await closeEmptyScope(scope);
        });
      }
    },
  };

  function relevantScopes(workspaceId: string): SharedScope[] {
    return [...scopes.values()].filter(
      (scope) =>
        scope.owner?.workspaceId === workspaceId ||
        [...scope.observations].some((observation) => observation.workspaceId === workspaceId),
    );
  }

  async function observe(
    workspaceId: string,
    driver: WorkspaceRuntimeDriver,
    listener: () => void,
  ): Promise<{ unsubscribe(): Promise<void> }> {
    const inspection = await driver.inspect(workspaceId);
    if (inspection.status !== "ready") {
      throw new Error(`Workspace runtime is ${inspection.status}: ${workspaceId}`);
    }
    const root = await discoverCommonGitDirectory(driver, workspaceId);
    if (!root) return { unsubscribe: async () => {} };
    assertRuntimeAbsolutePath(root);
    const key = `${inspection.state.executionDomainId}\0${root}`;
    const scope = scopes.get(key) ?? {
      key,
      root,
      observations: new Set(),
      owner: null,
      tail: Promise.resolve(),
    };
    scopes.set(key, scope);
    const logical: LogicalObservation = { workspaceId, driver, listener, scope };
    await withScope(scope, async () => {
      scope.observations.add(logical);
      try {
        if (!scope.owner) {
          const staged = await stageReplacementOwner(scope, workspaceId);
          await staged.commit();
        } else {
          const staged = await stageBindings(scope.owner, [logical]);
          await staged.commit();
        }
      } catch (error) {
        removeLogicalObservation(logical);
        await closeEmptyScope(scope);
        throw error;
      }
    });
    let active = true;
    return {
      async unsubscribe() {
        if (!active) return;
        active = false;
        await withScope(scope, async () => {
          const binding = scope.owner?.bindings.get(logical);
          scope.owner?.bindings.delete(logical);
          await binding?.unsubscribe();
          removeLogicalObservation(logical);
          await closeEmptyScope(scope);
        });
      },
    };
  }

  async function pauseInScope(scope: SharedScope, workspaceId: string): Promise<void> {
    if (scope.owner?.workspaceId === workspaceId) {
      const candidates = readyObservations(scope);
      if (candidates.length === 0) {
        await closeOwner(scope);
        return;
      }
      const staged = await stageReplacementOwner(scope);
      await staged.commit();
      return;
    }
    if (!scope.owner) return;
    const owned = [...scope.owner.bindings].filter(
      ([observation]) => observation.workspaceId === workspaceId,
    );
    for (const [observation, binding] of owned) {
      scope.owner.bindings.delete(observation);
      await binding.unsubscribe();
    }
  }

  async function stageScopeResume(
    scope: SharedScope,
    workspaceId: string,
  ): Promise<ObservationRebindTransaction> {
    const missing = [...scope.observations].filter(
      (observation) =>
        observation.workspaceId === workspaceId && !scope.owner?.bindings.has(observation),
    );
    if (missing.length === 0) return noOpTransaction();
    if (!scope.owner) return stageReplacementOwner(scope, workspaceId);
    return stageBindings(scope.owner, missing);
  }

  async function stageReplacementOwner(
    scope: SharedScope,
    allowedWorkspaceId?: string,
  ): Promise<ObservationRebindTransaction> {
    const candidates = readyObservations(scope, allowedWorkspaceId);
    const selected = candidates[0];
    if (!selected) throw new Error("Git common observation has no ready workspace owner");
    const client = bindWorkspaceHelper({
      root: scope.root,
      command: selected.driver.workspaceHelperCommand,
      launch: async (argv) => {
        const process = await options.launchHelper(selected.driver, selected.workspaceId, argv);
        if (process.kind !== "pipes") {
          throw new Error("Git common observation helper requires pipe mode");
        }
        return process;
      },
    });
    const owner: PhysicalOwner = {
      workspaceId: selected.workspaceId,
      client,
      bindings: new Map(),
    };
    const staged = await stageBindings(owner, candidates).catch(async (error) => {
      await client.close();
      throw error;
    });
    let finished = false;
    return {
      async commit() {
        if (finished) return;
        finished = true;
        const previous = scope.owner;
        await previous?.client.close();
        scope.owner = owner;
        await staged.commit();
      },
      async rollback() {
        if (finished) return;
        finished = true;
        await staged.rollback();
        await client.close();
      },
    };
  }

  async function stageBindings(
    owner: PhysicalOwner,
    observations: readonly LogicalObservation[],
  ): Promise<ObservationRebindTransaction> {
    let committed = false;
    const staged = new Map<LogicalObservation, WorkspaceFilesSubscription>();
    try {
      for (const observation of observations) {
        if (owner.bindings.has(observation)) continue;
        staged.set(
          observation,
          await owner.client.files.subscribe(
            { paths: ["."], recursive: true, ignoredPaths: ["objects"] },
            (event) => {
              if (
                committed &&
                event.type !== "error" &&
                !options.isUnavailable(observation.workspaceId)
              ) {
                observation.listener();
              }
            },
          ),
        );
      }
    } catch (error) {
      await Promise.allSettled([...staged.values()].map((binding) => binding.unsubscribe()));
      throw error;
    }
    let finished = false;
    return {
      async commit() {
        if (finished) return;
        finished = true;
        for (const [observation, binding] of staged) owner.bindings.set(observation, binding);
        committed = true;
      },
      async rollback() {
        if (finished) return;
        finished = true;
        await Promise.allSettled([...staged.values()].map((binding) => binding.unsubscribe()));
      },
    };
  }

  function readyObservations(
    scope: SharedScope,
    allowedWorkspaceId?: string,
  ): LogicalObservation[] {
    return [...scope.observations].filter(
      (observation) =>
        observation.workspaceId === allowedWorkspaceId ||
        !options.isUnavailable(observation.workspaceId),
    );
  }

  function removeLogicalObservation(observation: LogicalObservation): void {
    observation.scope.observations.delete(observation);
  }

  async function closeEmptyScope(scope: SharedScope): Promise<void> {
    if (scope.observations.size > 0) return;
    await closeOwner(scope);
    if (scopes.get(scope.key) === scope) scopes.delete(scope.key);
  }

  async function closeOwner(scope: SharedScope): Promise<void> {
    const owner = scope.owner;
    scope.owner = null;
    await owner?.client.close();
  }

  async function discoverCommonGitDirectory(
    driver: WorkspaceRuntimeDriver,
    workspaceId: string,
  ): Promise<string | null> {
    const process = await options.runGit(driver, workspaceId, [
      "git",
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (process.kind !== "pipes") throw new Error("Git common directory discovery requires pipes");
    process.stdin.end();
    const [stdout, stderr, exit] = await Promise.all([
      collect(process.stdout, process),
      collect(process.stderr, process),
      process.exited,
    ]);
    if (exit.code !== 0 || exit.signal !== null) return null;
    const root = stdout.trim();
    if (!root && stderr.trim()) return null;
    return root || null;
  }

  async function withScope<T>(scope: SharedScope, operation: () => Promise<T>): Promise<T> {
    const locked = await lockScopes([scope]);
    try {
      return await operation();
    } finally {
      locked.release();
    }
  }

  async function lockScopes(
    requested: readonly SharedScope[],
  ): Promise<{ scopes: SharedScope[]; release(): void }> {
    const ordered = [...new Set(requested)].sort((left, right) =>
      left.key.localeCompare(right.key),
    );
    const releases: Array<() => void> = [];
    for (const scope of ordered) {
      const previous = scope.tail;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      scope.tail = previous.then(() => gate);
      await previous;
      releases.push(release);
    }
    let released = false;
    return {
      scopes: ordered,
      release() {
        if (released) return;
        released = true;
        for (const release of releases.toReversed()) release();
      },
    };
  }
}

function combineTransactions(
  transactions: readonly ObservationRebindTransaction[],
): ObservationRebindTransaction {
  let finished = false;
  return {
    async commit() {
      if (finished) return;
      finished = true;
      for (const transaction of transactions) await transaction.commit();
    },
    async rollback() {
      if (finished) return;
      finished = true;
      await Promise.allSettled(transactions.map((transaction) => transaction.rollback()));
    },
  };
}

function noOpTransaction(): ObservationRebindTransaction {
  return { commit: async () => {}, rollback: async () => {} };
}

function finishWithRelease(
  transaction: ObservationRebindTransaction,
  release: () => void,
): ObservationRebindTransaction {
  let finished = false;
  return {
    async commit() {
      if (finished) return;
      finished = true;
      try {
        await transaction.commit();
      } finally {
        release();
      }
    },
    async rollback() {
      if (finished) return;
      finished = true;
      try {
        await transaction.rollback();
      } finally {
        release();
      }
    },
  };
}

function assertRuntimeAbsolutePath(root: string): void {
  if (!nodePath.posix.isAbsolute(root) && !nodePath.win32.isAbsolute(root)) {
    throw new Error("Git common directory must be runtime-absolute");
  }
}

async function collect(
  stream: NodeJS.ReadableStream,
  process: WorkspaceDriverProcess,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_DISCOVERY_OUTPUT_BYTES) {
      process.kill("SIGKILL");
      throw new Error("Git common directory discovery exceeded 64 KiB");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

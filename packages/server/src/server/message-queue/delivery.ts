import type { QueueItem, QueueSnapshot } from "@getpaseo/protocol/message-queue";
import type { AgentStreamEvent, AgentPromptInput } from "../agent/agent-sdk-types.js";
import { MessageQueueStore } from "./store.js";

export interface QueueDeliveryPort {
  history?(agentId: string): Promise<AgentStreamEvent[]>;
  prepare(agentId: string, item: QueueItem, canStart: () => boolean): Promise<boolean>;
  complete?(agentId: string, queueIsEmpty: () => Promise<boolean>): Promise<void>;
  needsCompletion?(agentId: string): boolean;
  abandonGoal?(agentId: string): Promise<void>;
  load(item: QueueItem): Promise<AgentPromptInput>;
  // Synchronous admission must reserve the foreground turn before yielding.
  // Null means no provider call occurred; the persisted claim may be released.
  start(
    agentId: string,
    item: QueueItem,
    prompt: AgentPromptInput,
    canStart: () => boolean,
  ): AsyncGenerator<AgentStreamEvent> | null | Promise<AsyncGenerator<AgentStreamEvent> | null>;
  changed(snapshot: QueueSnapshot): void;
  failed(error: unknown, agentId: string): void;
}

export class QueueDeliveryWorker {
  private readonly running = new Map<string, Promise<void>>();
  private readonly requested = new Set<string>();
  private readonly halted = new Set<string>();
  private readonly immediate = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly store: MessageQueueStore,
    private readonly port: QueueDeliveryPort,
  ) {}

  wake(agentId: string): Promise<void> {
    if (this.closed || this.halted.has(agentId)) return Promise.resolve();
    this.requested.add(agentId);
    const current = this.running.get(agentId);
    if (current) return current;
    const run = this.pump(agentId)
      .catch((error: unknown) => this.reportFailure(error, agentId))
      .finally(() => {
        this.running.delete(agentId);
        // A state event can arrive after pump's final check but before this cleanup.
        // Keep its wake request alive and include the follow-up work in this promise.
        if (this.requested.has(agentId)) return this.wake(agentId);
      });
    this.running.set(agentId, run);
    return run;
  }

  private async reportFailure(error: unknown, agentId: string): Promise<void> {
    const message = error instanceof Error ? error.message : "Queue delivery could not continue.";
    try {
      const snapshot = await this.store.setDeliveryError(agentId, message);
      if (snapshot) this.port.changed(snapshot);
    } catch (storageError) {
      this.port.failed(storageError, agentId);
    }
    this.port.failed(error, agentId);
  }

  private async clearFailure(agentId: string): Promise<void> {
    const snapshot = await this.store.setDeliveryError(agentId, undefined);
    if (snapshot) this.port.changed(snapshot);
  }

  halt(agentId: string): boolean {
    const newlyHalted = !this.halted.has(agentId);
    this.halted.add(agentId);
    return newlyHalted;
  }

  wakeImmediate(agentId: string): Promise<void> {
    const existing = this.immediate.get(agentId);
    if (existing) return existing;
    const run = (async () => {
      if (this.closed || this.halted.has(agentId)) return;
      const snapshot = await this.store.read(agentId);
      const head = snapshot.items[0];
      if (!head?.sendNow || head.delivery.status !== "queued") return;
      const item = await this.store.claim(agentId);
      if (!item) return;
      this.port.changed(await this.store.read(agentId));
      await this.deliver(agentId, item);
    })()
      .catch((error: unknown) => this.reportFailure(error, agentId))
      .finally(() => {
        this.immediate.delete(agentId);
        void this.wake(agentId);
      });
    this.immediate.set(agentId, run);
    return run;
  }

  resume(agentId: string): void {
    this.halted.delete(agentId);
  }

  close(): void {
    this.closed = true;
    this.requested.clear();
  }

  private async pump(agentId: string): Promise<void> {
    do {
      this.requested.delete(agentId);
      await this.drain(agentId);
    } while (!this.closed && !this.halted.has(agentId) && this.requested.has(agentId));
  }

  private async drain(agentId: string): Promise<void> {
    while (!this.closed && !this.halted.has(agentId)) {
      const snapshot = await this.store.read(agentId);
      const head = snapshot.items[0];
      if (head?.delivery.status === "uncertain" && this.port.history) {
        const reconciled = await this.store.reconcileHistory(
          agentId,
          await this.port.history(agentId),
        );
        if (!reconciled.changed) return;
        this.port.changed(reconciled.snapshot);
        continue;
      }
      if (!head) {
        if (!snapshot.paused) {
          await this.port.complete?.(agentId, async () => {
            if (this.closed || this.halted.has(agentId)) return false;
            const current = await this.store.read(agentId);
            return (
              !this.closed &&
              !this.halted.has(agentId) &&
              !current.paused &&
              current.items.length === 0
            );
          });
          await this.clearFailure(agentId);
        }
        return;
      }
      if ((snapshot.paused && !head.sendNow) || head.delivery.status !== "queued") return;
      if (
        !head.sendNow &&
        !(await this.port.prepare(agentId, head, () => !this.closed && !this.halted.has(agentId)))
      )
        return;
      await this.clearFailure(agentId);
      const item = await this.store.claim(agentId);
      if (!item || item.delivery.status !== "dispatching") return;
      this.port.changed(await this.store.read(agentId));
      if (this.closed || this.halted.has(agentId)) {
        this.port.changed(await this.store.release(agentId, item));
        return;
      }
      if (!(await this.deliver(agentId, item))) return;
    }
  }

  private async deliver(agentId: string, item: QueueItem): Promise<boolean> {
    if (item.delivery.status !== "dispatching")
      throw new Error("Delivery requires a persisted claim");
    const attemptId = item.delivery.attemptId;
    let stream: AsyncGenerator<AgentStreamEvent> | null;
    try {
      if (this.closed || this.halted.has(agentId)) {
        this.port.changed(await this.store.release(agentId, item));
        return false;
      }
      if (
        item.sendNow &&
        !(await this.port.prepare(agentId, item, () => !this.closed && !this.halted.has(agentId)))
      )
        throw new Error("The task is not ready to accept the selected message.");
      const prompt = await this.port.load(item);
      if (this.closed || this.halted.has(agentId)) {
        this.port.changed(await this.store.release(agentId, item));
        return false;
      }
      stream = await this.port.start(
        agentId,
        item,
        prompt,
        () => !this.closed && !this.halted.has(agentId),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Message admission failed.";
      this.port.changed(
        await this.store.settle({
          agentId,
          messageId: item.id,
          attemptId,
          outcome: { status: "failed", reason },
        }),
      );
      return false;
    }
    if (!stream) {
      this.port.changed(await this.store.release(agentId, item));
      return false;
    }
    let accepted = false;
    try {
      for await (const event of stream) {
        if (event.type !== "turn_started" || accepted) continue;
        const snapshot = await this.store.settle({
          agentId,
          messageId: item.id,
          attemptId,
          outcome: { status: "accepted", turnId: event.turnId ?? null },
        });
        accepted = true;
        this.port.changed(snapshot);
      }
    } catch (error) {
      if (accepted) {
        this.port.failed(error, agentId);
        return false;
      }
      const reason =
        error instanceof Error ? error.message : "Provider acceptance could not be confirmed.";
      this.port.changed(
        await this.store.settle({
          agentId,
          messageId: item.id,
          attemptId,
          outcome: { status: "uncertain", reason },
        }),
      );
      return false;
    }
    if (!accepted) {
      this.port.changed(
        await this.store.settle({
          agentId,
          messageId: item.id,
          attemptId,
          outcome: {
            status: "uncertain",
            reason: "The provider stream ended without confirming acceptance.",
          },
        }),
      );
    }
    return accepted;
  }
}

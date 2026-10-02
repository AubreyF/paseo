import { randomUUID } from "node:crypto";
import type { RestartJob, RestartRequest } from "@getpaseo/protocol/execution-installation";

export interface RestartJournal {
  read(): RestartJob[];
  write(jobs: RestartJob[]): void;
}

export interface RestartExecutor {
  restart(target: RestartJob["target"]): Promise<string>;
}

export class RestartRequestError extends Error {}

/** The coordinator owns this queue, so daemon restarts cannot destroy the receipt. */
export class InstallationRestarts {
  private jobs: RestartJob[];
  private running = false;

  constructor(
    private readonly journal: RestartJournal,
    private readonly executor: RestartExecutor,
    private readonly now: () => number = Date.now,
  ) {
    this.jobs = journal.read();
    // A coordinator crash leaves execution ambiguous. Never replay a disruptive action.
    this.jobs = this.jobs.map((job) => {
      if (job.status !== "running" && job.status !== "approved") return job;
      return {
        ...job,
        status: "failed",
        detail: "Coordinator interrupted. Inspect target and request a new restart.",
      };
    });
    journal.write(this.jobs);
  }

  list(): RestartJob[] {
    return this.jobs.map((job) => ({ ...job }));
  }

  request(input: RestartRequest, requestedBy: RestartJob["requestedBy"]): RestartJob {
    const pending = this.jobs.filter(
      (job) =>
        job.requestedBy === requestedBy &&
        job.status === "pending" &&
        Date.parse(job.expiresAt) > this.now(),
    );
    const sameTarget = pending.find(
      (job) => job.target === input.target && Date.parse(job.expiresAt) > this.now(),
    );
    if (sameTarget)
      throw new RestartRequestError("A restart request for this target is already pending");
    if (pending.length >= 8) throw new RestartRequestError("Too many pending restart requests");
    const job: RestartJob = {
      ...input,
      id: randomUUID(),
      revision: randomUUID(),
      requestedBy,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + 30 * 60_000).toISOString(),
      status: "pending",
      detail: "Owner approval required. Running work on the selected daemon may be interrupted.",
    };
    this.commit([...this.jobs, job]);
    return { ...job };
  }

  decide(id: string, revision: string, decision: "approve" | "reject"): RestartJob {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || job.revision !== revision || job.status !== "pending") {
      throw new RestartRequestError("Restart request is missing, changed, or already decided");
    }
    if (Date.parse(job.expiresAt) <= this.now())
      throw new RestartRequestError("Restart approval expired");
    const next: RestartJob = { ...job, status: decision === "approve" ? "approved" : "rejected" };
    this.replace(next);
    return { ...next };
  }

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.jobs.find((candidate) => candidate.status === "approved");
        if (!job) return;
        if (Date.parse(job.expiresAt) <= this.now()) {
          this.replace({ ...job, status: "failed", detail: "Approval expired before dispatch" });
          continue;
        }
        this.replace({
          ...job,
          status: "running",
          detail: "Restarting the approved target and checking its identity and readiness",
        });
        try {
          const detail = await this.executor.restart(job.target);
          this.replace({ ...job, status: "succeeded", detail });
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Restart failed";
          this.replace({ ...job, status: "failed", detail });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private replace(next: RestartJob): void {
    this.commit(this.jobs.map((job) => (job.id === next.id ? next : job)));
  }

  private commit(jobs: RestartJob[]): void {
    this.journal.write(jobs);
    this.jobs = jobs;
  }
}

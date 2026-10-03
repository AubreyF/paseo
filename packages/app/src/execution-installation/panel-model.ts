import type { ProfileSharingStatus, RestartJob } from "@getpaseo/protocol/execution-installation";
import type { InstallationClient } from "./client";

interface InstallationPanelState {
  visible: boolean;
  unlocked: boolean;
  busy: boolean;
  password: string;
  error: string | null;
  jobs: RestartJob[];
  profileSharing: ProfileSharingStatus | null;
}

export class InstallationPanelModel {
  private state: InstallationPanelState = {
    visible: true,
    unlocked: false,
    busy: false,
    password: "",
    error: null,
    jobs: [],
    profileSharing: null,
  };
  private listeners = new Set<() => void>();
  private refreshing = false;
  private seenRequests = new Set<string>();

  constructor(
    private readonly client: Pick<
      InstallationClient,
      "unlock" | "listRestarts" | "decide" | "profileSharingStatus" | "resolveProfileConflict"
    >,
    options: { connectionsRegistered: boolean } = { connectionsRegistered: false },
  ) {
    this.state.visible = !options.connectionsRegistered;
  }

  getState = (): InstallationPanelState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  open(): void {
    this.publish({ visible: true });
  }
  close(): void {
    if (!this.state.busy) this.publish({ visible: false });
  }
  setPassword(password: string): void {
    this.publish({ password });
  }

  async unlock(): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null });
    try {
      await this.client.unlock(this.state.password);
      this.publish({ unlocked: true, password: "", visible: false });
      await this.refresh();
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ busy: false });
    }
  }

  async refresh(): Promise<void> {
    if (!this.state.unlocked || this.refreshing) return;
    this.refreshing = true;
    try {
      const [jobs, profileSharing] = await Promise.all([
        this.client.listRestarts(),
        this.client.profileSharingStatus(),
      ]);
      const pending = jobs.filter(
        (job) => job.status === "pending" && Date.parse(job.expiresAt) > Date.now(),
      );
      const newRequest = pending.some((job) => !this.seenRequests.has(job.id));
      for (const job of pending) this.seenRequests.add(job.id);
      this.publish({ jobs, profileSharing, ...(newRequest ? { visible: true } : {}) });
    } catch (error) {
      this.fail(error);
    } finally {
      this.refreshing = false;
    }
  }

  async decide(job: RestartJob, decision: "approve" | "reject"): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null });
    try {
      await this.client.decide(job, decision);
      await this.refresh();
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ busy: false });
    }
  }

  async resolveProfileConflict(serverId: string, choice: "shared" | "environment"): Promise<void> {
    const snapshot = this.state.profileSharing;
    if (this.state.busy || !snapshot) return;
    this.publish({ busy: true, error: null });
    try {
      await this.client.resolveProfileConflict({
        serverId,
        expectedRevision: snapshot.revision,
        choice,
      });
      await this.refresh();
    } catch (error) {
      this.fail(error);
    } finally {
      this.publish({ busy: false });
    }
  }

  private fail(error: unknown): void {
    this.publish({ error: error instanceof Error ? error.message : "Installation request failed" });
  }
  private publish(update: Partial<InstallationPanelState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
}

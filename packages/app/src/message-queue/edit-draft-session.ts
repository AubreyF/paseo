import type { QueueItem } from "@getpaseo/protocol/message-queue";
import {
  type QueueEditDraft,
  type QueueEditDraftStorage,
  draftHasContent,
  validateDraftAttachments,
} from "./edit-draft";

export interface QueueEditDraftPort {
  storage: QueueEditDraftStorage;
  identity(): string;
  commit(draft: QueueEditDraft): Promise<void>;
  cleanup(draft: QueueEditDraft): Promise<void>;
}

// Drafts are independently identified: two tabs can edit the same message without
// overwriting each other's unsaved work. The server revision arbitrates Save.
export class QueueEditDraftSession {
  constructor(private readonly port: QueueEditDraftPort) {}

  async open(serverId: string, agentId: string, item: QueueItem): Promise<QueueEditDraft> {
    const draft: QueueEditDraft = {
      version: 1,
      id: this.port.identity(),
      serverId,
      agentId,
      revision: 0,
      original: item,
      text: item.text,
      attachments: item.attachments,
      localAttachments: [],
      submissionId: null,
    };
    if (!(await this.port.storage.exchange(draft, null)))
      throw new Error("Could not create the queue edit.");
    return draft;
  }

  async update(
    current: QueueEditDraft,
    changes: Pick<QueueEditDraft, "text" | "attachments" | "localAttachments">,
  ): Promise<QueueEditDraft> {
    if (current.submissionId)
      throw new Error(
        "This edit has already been submitted. Review its synchronization status first.",
      );
    const next = { ...current, ...changes, revision: current.revision + 1 };
    validateDraftAttachments(next);
    if (!(await this.port.storage.exchange(next, current.revision)))
      throw new Error(
        "This draft changed in another tab. Your current edit has not overwritten it.",
      );
    return next;
  }

  async discard(draft: QueueEditDraft): Promise<void> {
    if (!(await this.port.storage.remove(draft.id, draft.revision)))
      throw new Error(
        "This draft changed in another tab. Reload its saved copy before discarding it.",
      );
    await this.port.cleanup(draft);
  }

  async save(draft: QueueEditDraft): Promise<void> {
    if (draft.submissionId)
      throw new Error(
        "This edit may already be saved. Check the queue before submitting another edit.",
      );
    if (!draftHasContent(draft))
      throw new Error("Add text, an attachment, or context before saving.");
    validateDraftAttachments(draft);
    const submitted = {
      ...draft,
      revision: draft.revision + 1,
      submissionId: this.port.identity(),
    };
    if (!(await this.port.storage.exchange(submitted, draft.revision)))
      throw new Error("This draft changed in another tab. Review its saved copy before sending.");
    // A crash after commit but before removal leaves a visible submitted draft.
    // Never automatically replay it: acknowledgement may already have removed the outbox record.
    await this.port.commit(submitted);
    await this.discard(submitted);
  }
}

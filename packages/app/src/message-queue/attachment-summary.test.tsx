// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharedQueueView } from "./queue-view";

const state = vi.hoisted(() => ({ visible: true, pending: false, media: true }));
vi.mock("./use-message-queue", () => ({
  useMessageQueue: () => ({
    visible: state.visible,
    supported: true,
    connected: true,
    canMutate: true,
    snapshot: {
      revision: 0,
      paused: false,
      items: [
        { id: "text", text: "Text only", attachments: [], delivery: { status: "queued" } },
        {
          id: "media",
          text: "With attachment",
          attachments: [{ id: "image", kind: state.media ? "image" : "file" }],
          delivery: { status: "queued" },
        },
      ],
    },
    pending: state.pending
      ? [
          {
            operation: {
              kind: "enqueue",
              operationId: "local",
              text: "Local image",
              attachments: [],
            },
            localAttachments: [{ kind: "image", metadata: { fileName: "photo.png" } }],
            // Uploaded copies must not count twice while waiting for acknowledgement.
            prepared: { kind: "enqueue", attachments: [{ id: "uploaded", kind: "image" }] },
            error: null,
          },
        ]
      : [],
  }),
}));
vi.mock("./shared-attachments", () => ({ SharedQueueAttachments: () => null }));
vi.mock("@/components/ui/text-input", () => ({ EditingTextInput: () => null }));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("lucide-react-native", () => ({
  Image: () => <span data-testid="media-icon" />,
  Paperclip: () => <span data-testid="file-icon" />,
}));
vi.mock("@/styles/theme", () => ({
  baseColors: { zinc: { 800: "black" } },
  ICON_SIZE: { sm: 16 },
}));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock("react-native", () => ({
  View: ({
    children,
    testID,
    accessibilityLabel,
  }: {
    children: React.ReactNode;
    testID?: string;
    accessibilityLabel?: string;
  }) => (
    <div data-testid={testID} aria-label={accessibilityLabel}>
      {children}
    </div>
  ),
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  ScrollView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.visible = true;
  state.pending = false;
  state.media = true;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<SharedQueueView serverId="host" agentId="agent" />));
}
it("marks an image row while leaving the text-only row unmarked", async () => {
  await render();
  expect(
    container.querySelector(
      '[data-testid="queue-message-text"] [data-testid="queue-attachment-summary"]',
    ),
  ).toBeNull();
  const row = container.querySelector('[data-testid="queue-message-media"]');
  expect(row?.querySelector('[aria-label="1 attachment"]')).not.toBeNull();
  expect(row?.querySelector('[data-testid="media-icon"]')).not.toBeNull();
});
it("uses a file icon for non-image attachments", async () => {
  state.media = false;
  await render();
  expect(container.querySelector('[data-testid="file-icon"]')).not.toBeNull();
});
it("marks a locally saved image before host acknowledgement without counting its upload twice", async () => {
  state.pending = true;
  await render();
  expect(container.querySelectorAll('[aria-label="1 attachment"]')).toHaveLength(2);
  expect(container.textContent).toContain("Local image");
});
it("preserves the Vorton visibility gate", async () => {
  state.visible = false;
  await render();
  expect(container.childElementCount).toBe(0);
});

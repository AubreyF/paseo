// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SharedQueueAttachments } from "./shared-attachments";

const state = vi.hoisted(() => ({
  vorton: true,
  get: vi.fn(),
  read: vi.fn(),
  token: vi.fn(),
  download: vi.fn(),
}));
vi.mock("@/vorton-mode", () => ({ useVortonMode: () => state.vorton }));
vi.mock("./runtime", () => ({
  requireQueueClient: () => ({
    getMessageQueueAttachment: state.get,
    readFile: state.read,
    requestDownloadToken: state.token,
  }),
}));
vi.mock("@/runtime/host-runtime", () => ({ useHosts: () => [{ serverId: "host" }] }));
vi.mock("@/stores/download-store", () => ({
  useDownloadStore: { getState: () => ({ startDownload: state.download }) },
}));
vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) } }));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: React.ReactNode;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/attachment-lightbox", () => ({
  AttachmentLightbox: ({ source }: { source: { uri: string } | null }) =>
    source ? <img src={source.uri} alt="Shared preview" /> : null,
}));

let root: Root;
let container: HTMLDivElement;
const attachment = {
  id: "image",
  fileName: "photo.png",
  mimeType: "image/png",
  size: 3,
  kind: "image" as const,
};
const presentation = { attachments: [attachment] };
async function render() {
  await act(async () =>
    root.render(
      <SharedQueueAttachments
        serverId="host"
        agentId="agent"
        messageId="stable-queue-id"
        presentation={presentation}
      />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.vorton = true;
  state.get.mockResolvedValue({
    file: { attachment, cwd: "/captured", path: "content" },
    error: null,
  });
  state.read.mockResolvedValue({ bytes: new Uint8Array([97, 98, 99]) });
  state.token.mockResolvedValue({
    token: "token",
    fileName: "content",
    mimeType: "application/octet-stream",
    error: null,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("hides shared controls in Paseo mode and restores them without fetching", async () => {
  state.vorton = false;
  await render();
  expect(container.textContent).toBe("");
  expect(state.get).not.toHaveBeenCalled();
  state.vorton = true;
  await render();
  expect(container.textContent).toContain("photo.png");
  expect(state.get).not.toHaveBeenCalled();
});
it("loads a captured image by stable queue identity only when opened", async () => {
  await render();
  await act(async () => container.querySelector("button")!.click());
  expect(state.get).toHaveBeenCalledWith({
    agentId: "agent",
    messageId: "stable-queue-id",
    attachmentId: "image",
  });
  expect(state.read).toHaveBeenCalledWith("/captured", "content", undefined, 4);
  expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,YWJj");
});
it("shows host errors without trying an unchecked file path", async () => {
  state.get.mockResolvedValue({ file: null, error: { message: "Attachment was removed" } });
  await render();
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Attachment was removed");
  expect(state.read).not.toHaveBeenCalled();
});
it("uses the existing download flow with captured attachment metadata", async () => {
  state.get.mockResolvedValue({
    file: {
      attachment: { ...attachment, kind: "file", fileName: "notes.txt", mimeType: "text/plain" },
      cwd: "/captured",
      path: "content",
      downloadToken: "token",
    },
    error: null,
  });
  await render();
  await act(async () => container.querySelector("button")!.click());
  const request = state.download.mock.calls[0][0];
  expect(request.fileName).toBe("notes.txt");
  expect(await request.requestFileDownloadToken("content")).toMatchObject({
    token: "token",
    fileName: "notes.txt",
    mimeType: "text/plain",
  });
  expect(state.get).toHaveBeenLastCalledWith({
    agentId: "agent",
    messageId: "stable-queue-id",
    attachmentId: "image",
    download: true,
  });
  expect(state.read).not.toHaveBeenCalled();
});

const textContext = {
  attachments: [],
  context: [
    {
      type: "text" as const,
      mimeType: "text/plain" as const,
      title: "Selection",
      text: "Captured selection",
    },
  ],
};
it("shows captured context without requiring a file attachment or host request", async () => {
  await act(async () =>
    root.render(
      <SharedQueueAttachments
        serverId="host"
        agentId="agent"
        messageId="message"
        presentation={textContext}
      />,
    ),
  );
  expect(container.textContent).toContain("View Selection");
  expect(container.textContent).not.toContain("Captured selection");
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Captured selection");
  expect(state.get).not.toHaveBeenCalled();
});

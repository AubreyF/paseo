import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WorkspaceTitleSuggestions } from "./workspace-title-suggestions";

const state = vi.hoisted(() => ({ suggest: vi.fn<() => Promise<string[]>>() }));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => true }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => ({ suggestWorkspaceTitles: state.suggest }) }),
}));
let root: Root;
let container: HTMLDivElement;
let query: QueryClient;
const workspace = { serverId: "host", workspaceId: "workspace", name: "Original" };
const select = vi.fn();
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  query.clear();
  vi.unstubAllGlobals();
});

test.each([520, 320])(
  "keeps the dialog and footer still through generation at %ipx",
  async (width) => {
    let finish!: (titles: string[]) => void;
    let fail!: (error: Error) => void;
    state.suggest.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    container.style.cssText = `display:flex;flex-direction:column;gap:12px;width:${width - 48}px;padding:24px;position:fixed;top:50%;transform:translateY(-50%);`;
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <QueryClientProvider client={query}>
          <input aria-label="Workspace title" defaultValue="Manual title" />
          <WorkspaceTitleSuggestions workspace={workspace} onSelect={select} disabled={false} />
          <button type="button" data-testid="footer">
            Rename
          </button>
        </QueryClientProvider>,
      ),
    );
    function geometry() {
      const footer = container.querySelector('[data-testid="footer"]');
      const slots = container.querySelector('[data-testid="workspace-title-suggestion-slots"]');
      if (!footer || !slots) throw new Error("Missing suggestion layout");
      const dialog = container.getBoundingClientRect();
      return [
        dialog.top,
        dialog.height,
        footer.getBoundingClientRect().top,
        slots.getBoundingClientRect().height,
      ];
    }
    const initial = geometry();
    // The fixture's 16px interface font needs 36px per two-line row.
    expect(initial[3]).toBe(108);
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    const frames: number[][] = [];
    let frame = 0;
    function sample() {
      frames.push(geometry());
      frame = requestAnimationFrame(sample);
    }
    frame = requestAnimationFrame(sample);
    try {
      await act(async () =>
        finish([
          "Assess multi-client status and propose completion architecture",
          "Design authority and consumer roles for desktop clients",
          "Review same-account clients and plan remaining work",
        ]),
      );
      await vi.waitFor(() => expect(container.textContent).toContain("Assess multi-client"));
      expect(geometry()).toEqual(initial);
      expect(container.querySelector('[role="progressbar"]')).toBeNull();
      const regenerate = container.querySelector<HTMLButtonElement>(
        '[data-testid="workspace-title-regenerate"]',
      );
      if (!regenerate) throw new Error("Missing Regenerate");
      act(() => regenerate.click());
      await vi.waitFor(() =>
        expect(container.querySelector('[role="progressbar"]')).not.toBeNull(),
      );
      expect(geometry()).toEqual(initial);
      await act(async () => fail(new Error("Generation failed. Try again.")));
      await vi.waitFor(() => expect(container.textContent).toContain("Generation failed"));
      expect(geometry()).toEqual(initial);
      act(() => regenerate.click());
      await vi.waitFor(() =>
        expect(container.querySelector('[role="progressbar"]')).not.toBeNull(),
      );
      await act(async () => finish(["First", "Second", "Third"]));
      await vi.waitFor(() => expect(container.textContent).toContain("Third"));
      expect(geometry()).toEqual(initial);
      const titleRows = container.querySelectorAll(
        '[data-testid="workspace-title-suggestion-slots"] [role="button"]',
      );
      expect(titleRows).toHaveLength(3);
      const first = titleRows[0].getBoundingClientRect();
      const second = titleRows[1].getBoundingClientRect();
      expect(first.height).toBe(36);
      expect(second.top - first.top).toBe(36);
      const slots = container.querySelector('[data-testid="workspace-title-suggestion-slots"]');
      expect(titleRows[2].getBoundingClientRect().bottom).toBe(
        slots?.getBoundingClientRect().bottom,
      );
      expect(frames.length).toBeGreaterThan(0);
      for (const geometryAtFrame of frames) expect(geometryAtFrame).toEqual(initial);
    } finally {
      cancelAnimationFrame(frame);
    }
  },
);

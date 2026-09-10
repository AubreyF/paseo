// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DictationOverlay } from "./dictation-controls";

const mode = vi.hoisted(() => ({ touch: false }));
vi.mock("@/vorton-touch", () => ({ useVortonTouch: () => mode.touch }));
vi.mock("./volume-meter", () => ({ VolumeMeter: () => null }));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function button(action: string) {
  const element = host.querySelector(`[aria-label="message.dictation.${action}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${action}`);
  return element;
}
it.each([false, true])("keeps edit, submit and cancel independent with touch=%s", (touch) => {
  mode.touch = touch;
  const edit = vi.fn();
  const send = vi.fn();
  const cancel = vi.fn();
  act(() =>
    root.render(
      <DictationOverlay
        volume={0}
        duration={2}
        isRecording
        isProcessing={false}
        status="recording"
        onCancel={cancel}
        onAccept={edit}
        onAcceptAndSend={send}
      />,
    ),
  );
  act(() => button("insert").click());
  expect(edit).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  act(() => button("insertAndSend").click());
  expect(send).toHaveBeenCalledTimes(1);
  act(() => button("cancel").click());
  expect(cancel).toHaveBeenCalledTimes(1);
});
it.each([false, true])("prevents duplicate actions while processing with touch=%s", (touch) => {
  mode.touch = touch;
  const action = vi.fn();
  act(() =>
    root.render(
      <DictationOverlay
        volume={0}
        duration={2}
        isRecording={false}
        isProcessing
        status="uploading"
        onCancel={action}
        onAccept={action}
        onAcceptAndSend={action}
      />,
    ),
  );
  act(() => button("cancel").click());
  expect(action).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="message.dictation.insert"]')).toBeNull();
  expect(host.querySelector('[aria-label="message.dictation.insertAndSend"]')).toBeNull();
});

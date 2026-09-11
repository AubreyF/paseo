import { expect, it, vi } from "vitest";
const mode = vi.hoisted(() => ({ touch: true, compact: true }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => mode.compact }));
vi.mock("@/vorton-touch", () => ({ useVortonTouch: () => mode.touch }));
import { useMobileComposerLayout } from "./mobile-layout";

it.each([
  [true, true, true],
  [true, false, false],
  [false, true, false],
])("gates mobile geometry for touch=%s compact=%s", (touch, compact, enabled) => {
  Object.assign(mode, { touch, compact });
  expect(useMobileComposerLayout().enabled).toBe(enabled);
});

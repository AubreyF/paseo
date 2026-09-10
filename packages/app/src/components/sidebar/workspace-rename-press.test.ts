import { JSDOM } from "jsdom";
import { afterEach, expect, test, vi } from "vitest";
import { isWorkspaceRenamePress } from "./workspace-rename-press";
vi.mock("@/constants/platform", () => ({ isWeb: true }));
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const dom = new JSDOM(
    '<button id="row"><span id="title">Title</span><button id="nested">Menu</button></button>',
  );
  vi.stubGlobal("MouseEvent", dom.window.MouseEvent);
  vi.stubGlobal("Element", dom.window.Element);
  const row = dom.window.document.createElement("div");
  row.setAttribute("role", "button");
  const title = dom.window.document.createElement("span");
  row.append(title);
  const nested = dom.window.document.createElement("button");
  row.append(nested);
  function press(
    options: { detail?: number; button?: number; nested?: boolean; touch?: boolean } = {},
  ) {
    const nativeEvent = new dom.window.MouseEvent("click", {
      detail: options.detail ?? 2,
      button: options.button ?? 0,
      bubbles: true,
    });
    if (options.touch) Object.defineProperty(nativeEvent, "pointerType", { value: "touch" });
    (options.nested ? nested : title).dispatchEvent(nativeEvent);
    return { nativeEvent, currentTarget: row };
  }
  return press;
}
test("only a primary mouse double click on the row enables rename in Vorton", () => {
  const press = fixture();
  expect(isWorkspaceRenamePress(press(), true)).toBe(true);
  expect(isWorkspaceRenamePress(press(), false)).toBe(false);
  expect(isWorkspaceRenamePress(press({ detail: 1 }), true)).toBe(false);
  expect(isWorkspaceRenamePress(press({ detail: 0 }), true)).toBe(false);
  expect(isWorkspaceRenamePress(press({ button: 2 }), true)).toBe(false);
  expect(isWorkspaceRenamePress(press({ nested: true }), true)).toBe(false);
  expect(isWorkspaceRenamePress(press({ touch: true }), true)).toBe(false);
});

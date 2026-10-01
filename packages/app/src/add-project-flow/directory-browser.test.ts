import { describe, expect, it } from "vitest";
import type { ProjectDirectoryBrowsePayload } from "@getpaseo/protocol/messages";
import { openDirectoryBrowser } from "./directory-browser";

describe("directory browser", () => {
  it("ignores a delayed response after navigating to a different location", async () => {
    const responses: Array<(payload: ProjectDirectoryBrowsePayload) => void> = [];
    const model = openDirectoryBrowser({
      browseProjectDirectories: () => new Promise((resolve) => responses.push(resolve)),
    });
    const first = model.browse({ rootId: "first" });
    const second = model.browse({ rootId: "second" });
    const payload = {
      roots: [],
      directory: null,
      error: null,
      errorCode: null,
      requestId: "second",
    };
    responses[1](payload);
    await second;
    responses[0]({ ...payload, requestId: "first", error: "old failure" });
    await first;
    expect(model.getState().result).toEqual(payload);
    expect(model.getState().error).toBeNull();
    model.close();
  });
  it("keeps the entered host path and reports transport failures", async () => {
    const model = openDirectoryBrowser({
      browseProjectDirectories: async () => {
        throw new Error("Host disconnected");
      },
    });
    model.setInput("~/Documents/Codex");
    await model.openHostPath();
    expect(model.getState()).toMatchObject({
      input: "~/Documents/Codex",
      error: "Host disconnected",
      loading: false,
    });
    model.close();
  });
});

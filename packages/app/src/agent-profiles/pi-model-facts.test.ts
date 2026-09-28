import { describe, expect, it } from "vitest";
import { piModelFacts } from "./pi-model-facts";

const model = { provider: "pi", id: "local/model", label: "Local model" };

describe("Pi model facts", () => {
  it("shows reported configuration without inferring image support or context limits", () => {
    expect(
      piModelFacts({ ...model, thinkingOptions: [{ id: "medium", label: "Medium" }] }),
    ).toEqual(["Reasoning"]);
    expect(piModelFacts(model)).toEqual([]);
  });

  it("includes configured limits and explicit input modalities", () => {
    expect(
      piModelFacts({
        ...model,
        contextWindowMaxTokens: 32768,
        metadata: { maxOutputTokens: 4096, inputModalities: ["text", "image"] },
      }),
    ).toEqual([
      `${(32768).toLocaleString()} context`,
      `${(4096).toLocaleString()} max output`,
      "Text",
      "Images",
    ]);
  });

  it("ignores malformed provider metadata and invalid limits", () => {
    expect(
      piModelFacts({
        ...model,
        contextWindowMaxTokens: -1,
        metadata: { maxOutputTokens: "4096", inputModalities: "image" },
      }),
    ).toEqual([]);
  });
});

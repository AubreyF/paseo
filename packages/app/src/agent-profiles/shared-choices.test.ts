import { expect, test } from "vitest";
import { sharedChoiceState } from "./shared-choices";

test("keeps shared reasoning visible but unavailable on a limited account", () => {
  const full = {
    models: [
      {
        provider: "one",
        id: "model",
        label: "Model",
        thinkingOptions: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
    ],
  };
  const limited = {
    models: [
      {
        provider: "two",
        id: "model",
        label: "Model",
        thinkingOptions: [{ id: "medium", label: "Medium" }],
      },
    ],
  };
  const selection = sharedChoiceState({
    profile: { id: "workflow", name: "Everyday", provider: "two", model: "model" },
    choices: { model: "model", thinkingOptionId: "high" },
    entry: limited,
    family: [full, limited],
  });
  expect(selection.choices).toEqual({ model: "model", thinkingOptionId: "high" });
  expect(selection.unavailable).toBe(true);
  expect(selection.thinkingOptions).toContainEqual({
    id: "high",
    value: "high",
    label: "High",
    available: false,
  });
  const supported = sharedChoiceState({
    profile: { id: "workflow", name: "Everyday", provider: "one", model: "model" },
    choices: selection.choices,
    entry: full,
    family: [full, limited],
  });
  expect(supported.unavailable).toBe(false);
  expect(supported.choices).toEqual(selection.choices);
});

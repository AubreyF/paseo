import { expect, it } from "vitest";
import {
  openAccountForm,
  suggestedCodexAccountName,
  suggestedAccountName,
  type CreatedCodexAccount,
} from "./account-form";

it("validates names and does not submit twice while creation is pending", async () => {
  let resolve: (account: CreatedCodexAccount) => void = () => {};
  const calls: string[] = [];
  const model = openAccountForm("operation-one", {
    create: (id, name) => {
      calls.push(`${id}:${name}`);
      return new Promise<CreatedCodexAccount>((done) => {
        resolve = done;
      });
    },
  });
  await model.submit();
  expect(calls).toHaveLength(0);
  model.setName(" Work ");
  const pending = model.submit();
  model.setName("Ignored while pending");
  await model.submit();
  expect(calls).toEqual(["operation-one:Work"]);
  resolve({ providerId: "account-one", name: "Work" });
  await pending;
  expect(model.getState()).toEqual({
    phase: "created",
    account: { providerId: "account-one", name: "Work" },
  });
});

it("retries uncertain creation with the original operation ID and shows the persisted name", async () => {
  const calls: string[] = [];
  const model = openAccountForm("stable-id", {
    async create(id) {
      calls.push(id);
      if (calls.length === 1) throw new Error("Response lost. Try again.");
      return { providerId: "created-on-first-attempt", name: "Original" };
    },
  });
  model.setName("Original");
  await model.submit();
  expect(model.getState()).toMatchObject({ phase: "editing", error: "Response lost. Try again." });
  model.setName("Changed");
  await model.submit();
  expect(calls).toEqual(["stable-id", "stable-id"]);
  expect(model.getState()).toMatchObject({ phase: "created", account: { name: "Original" } });
});

it("closing an editor prevents late completions from notifying an unmounted form", async () => {
  let finish: (account: CreatedCodexAccount) => void = () => {};
  const model = openAccountForm("closed", {
    create: () =>
      new Promise<CreatedCodexAccount>((resolve) => {
        finish = resolve;
      }),
  });
  model.setName("Work");
  const pending = model.submit();
  model.close();
  finish({ providerId: "work", name: "Work" });
  await pending;
  expect(model.getState().phase).toBe("creating");
});

it("numbers enabled additional Codex accounts independently of built-ins and other providers", () => {
  expect(suggestedCodexAccountName({})).toBe("Codex 1");
  expect(
    suggestedCodexAccountName({
      codex: { enabled: true },
      work: { extends: "codex", label: "Work", enabled: true },
      personal: { extends: "codex", label: "Personal" },
      retired: { extends: "codex", label: "Retired", enabled: false },
      claude: { enabled: true },
    }),
  ).toBe("Codex 3");
});

it("skips names reserved by enabled or disabled Codex accounts", () => {
  expect(
    suggestedCodexAccountName({
      first: { extends: "codex", label: "Codex 2" },
      retired: { extends: "codex", label: " codex 3 ", enabled: false },
    }),
  ).toBe("Codex 4");
});

it("submits the suggested name without requiring an edit", async () => {
  const model = openAccountForm("suggested", {
    initialName: "Codex 3",
    async create(providerId, name) {
      return { providerId, name };
    },
  });
  await model.submit();
  expect(model.getState()).toEqual({
    phase: "created",
    account: { providerId: "suggested", name: "Codex 3" },
  });
});

it("numbers additional Claude accounts independently and skips reserved names", () => {
  expect(suggestedAccountName({}, "claude")).toBe("Claude 1");
  expect(
    suggestedAccountName(
      {
        claude: { enabled: true },
        codexOne: { extends: "codex", enabled: true },
        work: { extends: "claude", label: "Work", enabled: true },
        personal: { extends: "claude", label: "Personal", enabled: true },
      },
      "claude",
    ),
  ).toBe("Claude 3");
  expect(
    suggestedAccountName(
      {
        work: { extends: "claude", label: "Claude 1", enabled: true },
        disabled: { extends: "claude", label: "CLAUDE 2", enabled: false },
      },
      "claude",
    ),
  ).toBe("Claude 3");
});

import { expect, it } from "vitest";
import { openAccountForm, type CreatedCodexAccount } from "./account-form";

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

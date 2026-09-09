import { expect, test } from "vitest";
import { supportsResetRedemption } from "./reset-capability.js";
import { CodexResetCreditSession } from "./reset-credits.js";

function schema(
  method = "account/rateLimitResetCredit/consume",
  required = ["idempotencyKey"],
  type = "string",
) {
  return {
    oneOf: [
      {
        required: ["params"],
        properties: { method: { enum: [method] }, params: { $ref: "#/definitions/Consume" } },
      },
    ],
    definitions: { Consume: { required, properties: { idempotencyKey: { type } } } },
  };
}

test("requires the exact method and a required string idempotency key", () => {
  expect(supportsResetRedemption(schema())).toBe(true);
  expect(supportsResetRedemption(schema("account/rateLimits/read"))).toBe(false);
  expect(supportsResetRedemption(schema(undefined, []))).toBe(false);
  expect(supportsResetRedemption(schema(undefined, undefined, "number"))).toBe(false);
  expect(supportsResetRedemption({})).toBe(false);
});

test("unverified runtimes cannot send a redemption request", async () => {
  let calls = 0;
  const session = new CodexResetCreditSession({
    request: async () => {
      calls += 1;
      return {};
    },
    dispose: async () => {},
  });
  await expect(
    session.consume({ accountId: "first", idempotencyKey: "00000000-0000-4000-8000-000000000001" }),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(calls).toBe(0);
});

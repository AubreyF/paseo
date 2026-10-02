import { expect, test } from "vitest";
import { validateExecutionInstallation } from "./execution-installation.js";

const installation = {
  version: 1,
  installationId: "3386c661-7e90-4e01-abf7-e7ca3b9fca00",
  origin: "https://installation.example.test",
  environments: [
    {
      kind: "container",
      serverId: "container-id",
      endpoint: "container.example.test",
      useTls: true,
    },
    { kind: "host", serverId: "host-id", endpoint: "host.example.test", useTls: true },
  ],
};

test("installation descriptors require distinct encrypted destinations and never contain passwords", () => {
  expect(validateExecutionInstallation(installation).environments).toHaveLength(2);
  expect(() =>
    validateExecutionInstallation({
      ...installation,
      environments: [installation.environments[0], installation.environments[0]],
    }),
  ).toThrow("distinct");
  expect(() =>
    validateExecutionInstallation({
      ...installation,
      environments: [
        { ...installation.environments[0], password: "secret" },
        installation.environments[1],
      ],
    }),
  ).toThrow();
  expect(() =>
    validateExecutionInstallation({
      ...installation,
      environments: [
        { ...installation.environments[0], endpoint: "container.example.test/path" },
        installation.environments[1],
      ],
    }),
  ).toThrow("endpoint");
  expect(() =>
    validateExecutionInstallation({
      ...installation,
      environments: [
        { ...installation.environments[0], useTls: false },
        installation.environments[1],
      ],
    }),
  ).toThrow("TLS");
});

import { expect, test } from "vitest";
import { InstallationClient } from "./client";
import {
  validateExecutionInstallation,
  type InstallationUnlock,
} from "@getpaseo/protocol/execution-installation";
import { maintenanceTaskTarget, installationMaintenancePrompt } from "./maintenance-task";

const installation = validateExecutionInstallation({
  version: 1,
  installationId: "3386c661-7e90-4e01-abf7-e7ca3b9fca00",
  origin: "https://owner.example.test",
  environments: [
    { kind: "container", serverId: "guest-id", endpoint: "guest.example.test", useTls: true },
    { kind: "host", serverId: "host-id", endpoint: "host.example.test", useTls: true },
  ],
});

test("unlock registers both verified environments atomically without probing a fallback", async () => {
  const registrations: InstallationUnlock["connections"][] = [];
  const client = new InstallationClient(installation, {
    request: async () => ({
      installationId: installation.installationId,
      connections: installation.environments.map((environment) => ({
        ...environment,
        password: `${environment.kind}-password`,
      })),
    }),
    register: {
      installExecutionEnvironments: async (connections) => {
        registrations.push(connections);
      },
    },
  });
  await client.unlock("owner-password");
  expect(registrations).toHaveLength(1);
  expect(registrations[0]?.map((environment) => environment.kind)).toEqual(["container", "host"]);
});

test("an endpoint or identity change rejects the entire unlock before any credentials are registered", async () => {
  let registered = false;
  const client = new InstallationClient(installation, {
    request: async () => ({
      installationId: installation.installationId,
      connections: installation.environments.map((environment) => ({
        ...environment,
        endpoint: "attacker.example.test",
        password: "secret",
      })),
    }),
    register: {
      installExecutionEnvironments: async () => {
        registered = true;
      },
    },
  });
  await expect(client.unlock("owner-password")).rejects.toThrow("reviewed environment");
  expect(registered).toBe(false);
  await expect(client.listRestarts()).rejects.toThrow("Unlock");
});

test("maintenance drafts target the host even if only the container is online and never silently substitute it", () => {
  expect(maintenanceTaskTarget(installation, ["guest-id", "host-id"])).toBe("host-id");
  expect(() => maintenanceTaskTarget(installation, ["guest-id"])).toThrow("host environment");
  expect(() => maintenanceTaskTarget(null, ["guest-id"])).toThrow("host environment");
  expect(installationMaintenancePrompt("Review upstream")).toContain("wait for owner approval");
});

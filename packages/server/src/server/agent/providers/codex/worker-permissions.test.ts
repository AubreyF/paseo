import { expect, test } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyWorkerPhysicalWorkspace,
  verifyWorkerPermissionProfile,
} from "./worker-permissions.js";

const denyAllProxy = {
  enabled: true,
  proxy_url: "http://127.0.0.1:0",
  enable_socks5: false,
  enable_socks5_udp: false,
  allow_upstream_proxy: false,
  dangerously_allow_non_loopback_proxy: false,
  dangerously_allow_all_unix_sockets: false,
  mode: "limited",
  domains: {},
  unix_sockets: {},
  allow_local_binding: false,
};
const proxyFeature = { enabled: true, credential_broker: false };
const workerProfile = {
  extends: null,
  workspace_roots: { "/fixture": true },
  filesystem: {
    ":root": "deny",
    ":minimal": "read",
    ":tmpdir": "deny",
    ":slash_tmp": "deny",
    ":workspace_roots": { ".": "write", ".codex": "deny", ".git": "read" },
  },
};

test("admits audited deny-all managed proxy and retains strict network-denied profiles", () => {
  expect(() =>
    verifyWorkerPermissionProfile(
      { ...workerProfile, network: denyAllProxy },
      "/fixture",
      proxyFeature,
    ),
  ).not.toThrow();
  expect(() =>
    verifyWorkerPermissionProfile({ ...workerProfile, network: { enabled: false } }, "/fixture"),
  ).not.toThrow();
});

test.each([
  { domains: { "example.invalid": "allow" } },
  { unix_sockets: { "/fixture/socket": "allow" } },
  { allow_upstream_proxy: true },
  { enable_socks5: true },
  { enable_socks5_udp: true },
  { allow_local_binding: true },
  { dangerously_allow_non_loopback_proxy: true },
  { dangerously_allow_all_unix_sockets: true },
  { proxy_url: "http://192.0.2.1:3128" },
  { mode: "full" },
  { mitm: {} },
  { credential_broker: true },
])("rejects network expansion or unverified defaults %j", (patch) => {
  expect(() =>
    verifyWorkerPermissionProfile(
      { ...workerProfile, network: { ...denyAllProxy, ...patch } },
      "/fixture",
      proxyFeature,
    ),
  ).toThrow("filesystem confinement");
});

test.each([
  undefined,
  false,
  true,
  { enabled: true },
  { enabled: true, credential_broker: true },
  { ...proxyFeature, domains: { "example.invalid": "allow" } },
])("requires the exact enabled proxy feature with broker disabled: %j", (feature) => {
  expect(() =>
    verifyWorkerPermissionProfile({ ...workerProfile, network: denyAllProxy }, "/fixture", feature),
  ).toThrow("managed proxy is unverified");
});

test("requires prepared directories without repairing missing or file deny targets", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "worker-paths-")));
  try {
    await expect(verifyWorkerPhysicalWorkspace(root)).rejects.toThrow();
    await writeFile(join(root, ".codex"), "fixture");
    await expect(verifyWorkerPhysicalWorkspace(root)).rejects.toThrow("physical workspace");
    await rm(join(root, ".codex"));
    await mkdir(join(root, ".codex"));
    await expect(verifyWorkerPhysicalWorkspace(root)).resolves.toBeUndefined();
    await expect(verifyWorkerPhysicalWorkspace("relative")).rejects.toThrow("physical workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinks in the workspace and protected directory paths", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "worker-links-")));
  const work = join(root, "work");
  const linked = join(root, "linked");
  const outside = join(root, "outside");
  try {
    await mkdir(work);
    await mkdir(outside);
    await mkdir(join(work, ".codex"));
    await symlink(work, linked, "junction");
    await expect(verifyWorkerPhysicalWorkspace(linked)).rejects.toThrow("physical workspace");
    await rm(join(work, ".codex"), { recursive: true });
    await symlink(outside, join(work, ".codex"), "junction");
    await expect(verifyWorkerPhysicalWorkspace(work)).rejects.toThrow("physical workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

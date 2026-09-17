import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

const Unset = z.null().optional();
const WorkerProfile = z
  .object({
    description: z.string().nullable().optional(),
    extends: Unset,
    workspace_roots: z.record(z.string(), z.literal(true)),
    filesystem: z
      .object({
        glob_scan_max_depth: Unset,
        ":root": z.literal("deny"),
        ":minimal": z.literal("read"),
        ":tmpdir": z.literal("deny"),
        ":slash_tmp": z.literal("deny"),
        ":workspace_roots": z
          .object({
            ".": z.literal("write"),
            ".codex": z.literal("deny"),
            ".git": z.literal("read"),
          })
          .strict(),
      })
      .strict(),
    network: z
      .object({
        enabled: z.literal(false),
        proxy_url: Unset,
        enable_socks5: Unset,
        socks_url: Unset,
        enable_socks5_udp: Unset,
        allow_upstream_proxy: Unset,
        dangerously_allow_non_loopback_proxy: Unset,
        dangerously_allow_all_unix_sockets: Unset,
        mode: Unset,
        domains: Unset,
        unix_sockets: Unset,
        allow_local_binding: Unset,
        mitm: Unset,
      })
      .strict(),
  })
  .strict();

// A profile name is provenance, not proof of its effective grants. Accept only
// the audited offline worker boundary; inherited profiles can widen it silently.
export function verifyWorkerPermissionProfile(profile: unknown, cwd: string | undefined): void {
  const result = WorkerProfile.safeParse(profile);
  if (!result.success || !cwd || !isAbsolute(cwd) || normalize(cwd) !== cwd) {
    throw new Error("Native worker filesystem confinement is unavailable.");
  }
  const roots = Object.keys(result.data.workspace_roots);
  if (roots.length !== 1 || roots[0] !== cwd) {
    throw new Error("Native worker filesystem confinement is unavailable.");
  }
}

export function verifyWorkerRuntimeRoots(roots: unknown, cwd: string | undefined): void {
  if (!cwd || !Array.isArray(roots) || roots.length !== 1 || roots[0] !== cwd) {
    throw new Error("Native worker runtime workspace roots are unverified.");
  }
}

import path from "node:path";

const REQUIRED_SANDBOX_MODE = 0o4755;
const PERMISSION_BITS = 0o7777;

interface SandboxMetadata {
  mode: number;
  uid: number;
}

type SandboxDisableReport =
  | {
      reason: "helper-missing";
      sandboxPath: string;
    }
  | {
      reason: "wrong-owner-or-mode";
      sandboxPath: string;
      observedUid: number;
      observedMode: string;
    };

interface LinuxSandboxConfiguration {
  platform: NodeJS.Platform;
  resourcesPath: string;
  statSandbox: (sandboxPath: string) => SandboxMetadata;
  disableSandbox: () => void;
  reportSandboxDisabled: (report: SandboxDisableReport) => void;
  reportInspectionError: (error: unknown) => void;
}

function isMissingSandbox(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function configureLinuxSandbox(input: LinuxSandboxConfiguration): void {
  if (input.platform !== "linux") {
    return;
  }

  const sandboxPath = path.join(input.resourcesPath, "..", "chrome-sandbox");

  try {
    const sandbox = input.statSandbox(sandboxPath);
    const hasUsableSandbox =
      sandbox.uid === 0 && (sandbox.mode & PERMISSION_BITS) === REQUIRED_SANDBOX_MODE;

    if (!hasUsableSandbox) {
      input.reportSandboxDisabled({
        reason: "wrong-owner-or-mode",
        sandboxPath,
        observedUid: sandbox.uid,
        observedMode: (sandbox.mode & PERMISSION_BITS).toString(8).padStart(4, "0"),
      });
      input.disableSandbox();
    }
  } catch (error) {
    if (isMissingSandbox(error)) {
      input.reportSandboxDisabled({ reason: "helper-missing", sandboxPath });
      input.disableSandbox();
      return;
    }

    input.reportInspectionError(error);
  }
}

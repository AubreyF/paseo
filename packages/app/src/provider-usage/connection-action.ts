import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { ProviderUsage } from "./types";

export function providerConnectionAction(input: {
  vortonMode: boolean;
  providerId: string;
  providers: MutableDaemonConfig["providers"] | undefined;
  usage: ProviderUsage | undefined;
}): "Connect" | "Reconnect" | null {
  if (!input.vortonMode) return null;
  if (input.usage?.authRecovery) return "Reconnect";
  const provider = input.providers?.[input.providerId];
  const codex = input.providerId === "codex" || provider?.extends === "codex";
  if (!codex || provider?.enabled === false || input.usage?.status === "available") return null;
  return "Connect";
}

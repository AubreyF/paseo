import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { presetNickname } from "./nickname";

export function profileDetails(profile: AgentProfile, entry?: ProviderSnapshotEntry) {
  const modeId = profile.modeId?.trim() || entry?.defaultModeId;
  const mode = entry?.modes?.find((candidate) => candidate.id === modeId);
  const permissions = mode?.label ?? modeId ?? "Provider default";
  const description =
    mode?.description ??
    (modeId
      ? "Permission details are unavailable from this provider."
      : "Uses the provider’s default permissions.");
  const features = Object.entries(profile.featureValues ?? {}).map(([key, value]) => {
    const label = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
    let display = JSON.stringify(value);
    if (typeof value === "boolean") display = value ? "On" : "Off";
    else if (typeof value === "string") display = value;
    return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${display}`;
  });
  return [
    {
      title: "Permissions",
      text: `${permissions}${profile.modeId?.trim() ? "" : " (provider default)"}\n${description}`,
    },
    { title: "Nickname", text: presetNickname(profile) },
    {
      title: "Features",
      text: features.length ? features.join("\n") : "No profile-specific feature overrides.",
    },
    { title: "When to use", text: profile.notes?.trim() || "No usage guidance configured." },
  ];
}

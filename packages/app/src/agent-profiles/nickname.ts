export function generatedPresetNickname(name: string): string {
  const words = name
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean);
  const initials = (parts: string[]) =>
    parts.map((word) => (/^\d+$/.test(word) ? word : Array.from(word)[0].toUpperCase())).join("");
  if (words[0]?.toLowerCase() === "codex") {
    const account = /^\d+$/.test(words[1] ?? "") ? words[1] : "";
    const suffix = initials(words.slice(account ? 2 : 1));
    return `C${account}${suffix ? `-${suffix}` : ""}`;
  }
  return initials(words) || "Preset";
}

export function presetNickname(profile: { name: string; nickname?: string }): string {
  return profile.nickname?.trim() || generatedPresetNickname(profile.name);
}

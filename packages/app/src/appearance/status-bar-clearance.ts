import { isAppleHandheldPlatform } from "../utils/terminal-keys";

interface StatusBarPlatform {
  userAgent: string;
  platform: string | undefined;
  maxTouchPoints: number | undefined;
  standalone?: boolean;
}

// iOS 27 Home Screen apps blur approximately 20 CSS pixels below the safe area.
// This is system compositing, not a page backdrop filter. Keep the clearance in
// chrome owners only, never on #root or the SafeAreaProvider (which would stack).
export function getStatusBarClearance(
  platform: StatusBarPlatform | null,
  topInset: number,
  vorton: boolean,
): number {
  if (!vorton || topInset <= 0 || platform?.standalone !== true) return 0;
  if (!isAppleHandheldPlatform(platform)) return 0;
  // Safari freezes the OS token on some releases. Prefer the browser version.
  const version = platform.userAgent.match(/Version\/(\d+)/)?.[1];
  const osVersion = platform.userAgent.match(/(?:CPU (?:iPhone )?OS) (\d+)[_\s]/)?.[1];
  return Number(version ?? osVersion ?? 0) >= 27 ? 20 : 0;
}

import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { limitingWindow, formatProviderUsageSummary } from "@/provider-usage/compact-summary";
import { clampPct, formatPct, formatResetLabel } from "@/provider-usage/format";
import type { ProviderUsage } from "@/provider-usage/types";
import { ProviderResetControl } from "@/provider-usage/reset-control";

export function PresetUsageRail({
  usage,
  localStatus,
  serverId,
  providerId,
  name,
}: {
  usage?: ProviderUsage;
  localStatus?: string;
  serverId: string | null;
  providerId: string;
  name: string;
}) {
  const window = limitingWindow(usage);
  const fill = useMemo(
    () => [styles.fill, { width: `${clampPct(window?.remainingPct ?? 0)}%` as `${number}%` }],
    [window?.remainingPct],
  );
  const meterValue = useMemo(
    () => ({ min: 0, max: 100, now: clampPct(window?.remainingPct ?? 0) }),
    [window?.remainingPct],
  );
  return (
    <View style={styles.rail}>
      {localStatus ? (
        <Text style={styles.meta}>{localStatus}</Text>
      ) : (
        <>
          {window ? (
            <>
              <Text style={styles.remaining}>{formatPct(window.remainingPct)} left</Text>
              <View
                style={styles.track}
                accessibilityRole="progressbar"
                accessibilityLabel="Usage remaining"
                accessibilityValue={meterValue}
              >
                <View style={fill} />
              </View>
              <Text style={styles.meta}>
                {formatResetLabel(window.resetsAt)
                  ?.replace(/^resets /, "resets in ")
                  .replace(/(\d+)d$/, (_, days) => `${days} ${days === "1" ? "day" : "days"}`) ??
                  "Reset time unavailable"}
              </Text>
            </>
          ) : (
            <Text style={styles.meta}>
              {formatProviderUsageSummary(usage) ?? "Usage unavailable"}
            </Text>
          )}
          <ProviderResetControl serverId={serverId} providerId={providerId} name={name} />
        </>
      )}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  rail: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    minHeight: 32,
  },
  remaining: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  meta: { fontSize: theme.fontSize.base, color: theme.colors.foregroundMuted },
  track: {
    width: 56,
    height: 4,
    borderRadius: theme.borderRadius.full,
    overflow: "hidden",
    backgroundColor: theme.colors.surface3,
  },
  fill: { height: "100%", backgroundColor: theme.colors.accent },
}));

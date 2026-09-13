import { ProviderReconnectControl } from "@/provider-usage/reconnect-control";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { formatProviderUsageSummary } from "@/provider-usage/compact-summary";
import { clampPct, formatPct, formatResetLabel } from "@/provider-usage/format";
import { quotaReading } from "@/provider-usage/quota-reading";
import type { ProviderUsageView } from "@/provider-usage/types";
import { ProviderResetControl } from "@/provider-usage/reset-control";

export function PresetUsageRail({
  view,
  now,
  localStatus,
  serverId,
  providerId,
  name,
}: {
  view: ProviderUsageView;
  now: number;
  localStatus?: string;
  serverId: string | null;
  providerId: string;
  name: string;
}) {
  const { window, usage, statusLabel, authRecovery } = quotaReading(view, providerId, now);
  const critical = Boolean(window && window.remainingPct < 5);
  const fill = useMemo(
    () => [
      styles.fill,
      critical && styles.criticalFill,
      { width: `${clampPct(window?.remainingPct ?? 0)}%` as `${number}%` },
    ],
    [window?.remainingPct, critical],
  );
  const meterValue = useMemo(
    () => ({ min: 0, max: 100, now: clampPct(window?.remainingPct ?? 0) }),
    [window?.remainingPct],
  );
  const content = localStatus ? (
    <Text style={styles.meta} numberOfLines={1}>
      {localStatus}
    </Text>
  ) : (
    <>
      {window ? (
        <>
          <Text style={[styles.remaining, critical && styles.critical]} numberOfLines={1}>
            {formatPct(window.remainingPct)} left
          </Text>
          <View
            style={[styles.track, critical && styles.criticalTrack]}
            accessibilityRole="progressbar"
            accessibilityLabel="Usage remaining"
            accessibilityValue={meterValue}
          >
            <View style={fill} />
          </View>
          <Text style={[styles.meta, critical && styles.critical]} numberOfLines={1}>
            {statusLabel ??
              formatResetLabel(window.resetsAt)
                ?.replace(/^resets /, "resets in ")
                .replace(/(\d+)d$/, (_, days) => `${days} ${days === "1" ? "day" : "days"}`) ??
              "Reset time unavailable"}
          </Text>
        </>
      ) : (
        <Text style={[styles.meta, critical && styles.critical]} numberOfLines={1}>
          {formatProviderUsageSummary(usage) ?? statusLabel}
        </Text>
      )}
      <View style={styles.resets}>
        <ProviderResetControl
          serverId={serverId}
          providerId={providerId}
          name={name}
          critical={critical}
          compact
          preloaded
        />
      </View>
    </>
  );
  return (
    <View style={styles.rail}>
      <ProviderReconnectControl usage={usage} serverId={serverId} name={name} />
      {!authRecovery ? content : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  rail: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "nowrap",
    minWidth: 0,
    gap: theme.spacing[2],
    height: Math.ceil(theme.fontSize.base * 1.4),
  },
  remaining: {
    flexShrink: 0,
    fontSize: theme.fontSize.base,
    lineHeight: Math.ceil(theme.fontSize.base * 1.4),
    color: theme.colors.foreground,
  },
  critical: { color: theme.colors.destructive },
  criticalTrack: { backgroundColor: theme.colors.destructive, opacity: 0.45 },
  criticalFill: { backgroundColor: theme.colors.destructive },
  resets: {
    width: 88,
    height: Math.ceil(theme.fontSize.base * 1.4),
    flexShrink: 0,
    marginLeft: "auto",
    alignItems: "flex-end",
  },
  meta: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    lineHeight: Math.ceil(theme.fontSize.base * 1.4),
    color: theme.colors.foregroundMuted,
  },
  track: {
    width: 40,
    flexShrink: 1,
    height: 4,
    borderRadius: theme.borderRadius.full,
    overflow: "hidden",
    backgroundColor: theme.colors.surface3,
  },
  fill: { height: "100%", backgroundColor: theme.colors.accent },
}));

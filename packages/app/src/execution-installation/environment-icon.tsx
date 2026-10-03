import { Box, Monitor, KeyRound } from "lucide-react-native";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useVortonMode } from "@/vorton-mode";
import { EXECUTION_ENVIRONMENT_COLORS, ICON_SIZE } from "@/styles/theme";
import { findInstallationEnvironment, readExecutionInstallation } from "./policy";

export function ExecutionEnvironmentIcon({ serverId }: { serverId: string | null }) {
  const enabled = useVortonMode();
  const environment =
    enabled && serverId ? findInstallationEnvironment(readExecutionInstallation(), serverId) : null;
  if (!environment) return null;
  const size = ICON_SIZE.sm;
  const color = EXECUTION_ENVIRONMENT_COLORS[environment.kind];
  if (environment.kind === "container") return <Box size={size} color={color} />;
  return (
    <View style={styles.monitor}>
      <Monitor size={size} color={color} />
      <View style={styles.key}>
        <KeyRound size={size / 2} color={color} />
      </View>
    </View>
  );
}

export function useHasExecutionEnvironment(serverId: string | null) {
  const enabled = useVortonMode();
  return Boolean(
    enabled && serverId && findInstallationEnvironment(readExecutionInstallation(), serverId),
  );
}

const styles = StyleSheet.create((theme) => ({
  monitor: { width: theme.iconSize.sm, height: theme.iconSize.sm },
  key: {
    position: "absolute",
    right: -theme.spacing[1],
    bottom: 0,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
  },
}));

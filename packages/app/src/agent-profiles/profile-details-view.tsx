import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { profileDetails } from "./profile-details";

export function ProfileDetailsView({
  serverId,
  profile,
}: {
  serverId: string | null;
  profile: AgentProfile;
}) {
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const sections = profileDetails(
    profile,
    entries?.find((entry) => entry.provider === profile.provider),
  );
  return (
    <View testID="profile-customization-details" style={styles.sections}>
      {sections.map((section) => (
        <View key={section.title} style={styles.section}>
          <Text style={styles.label}>{section.title}</Text>
          <Text style={styles.text} selectable>
            {section.text}
          </Text>
        </View>
      ))}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  sections: { gap: theme.spacing[4] },
  section: { gap: theme.spacing[2] },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
}));

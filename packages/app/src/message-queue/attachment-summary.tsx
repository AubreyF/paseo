import { Image as ImageIcon, Paperclip } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { baseColors, ICON_SIZE } from "@/styles/theme";

export function QueueAttachmentSummary({ count, hasMedia }: { count: number; hasMedia: boolean }) {
  if (!count) return null;
  const Icon = hasMedia ? ImageIcon : Paperclip;
  return (
    <View
      accessible
      accessibilityLabel={`${count} ${count === 1 ? "attachment" : "attachments"}`}
      style={styles.summary}
      testID="queue-attachment-summary"
    >
      <View style={styles.tile}>
        <Icon size={ICON_SIZE.sm} color={baseColors.zinc[800]} />
      </View>
      <Text style={styles.count}>{count}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  summary: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  // A metadata-only tile works offline and does not download full-size images.
  tile: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: baseColors.zinc[300],
    backgroundColor: baseColors.white,
  },
  count: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

import { Image as ImageIcon, Paperclip } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { type Theme, ICON_SIZE } from "@/styles/theme";

const ThemedImage = withUnistyles(ImageIcon);
const ThemedPaperclip = withUnistyles(Paperclip);
const iconColors = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function QueueAttachmentSummary({ count, hasMedia }: { count: number; hasMedia: boolean }) {
  if (!count) return null;
  const Icon = hasMedia ? ThemedImage : ThemedPaperclip;
  return (
    <View
      accessible
      accessibilityLabel={`${count} ${count === 1 ? "attachment" : "attachments"}`}
      style={styles.summary}
      testID="queue-attachment-summary"
    >
      <View style={styles.tile}>
        <Icon size={ICON_SIZE.xs} uniProps={iconColors} />
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
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  count: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

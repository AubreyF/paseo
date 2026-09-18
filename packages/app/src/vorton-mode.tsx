import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { settingsStyles } from "@/styles/settings";

const COMPACT_MODE_SEGMENT = { vortonCompactMode: "true" };

export function useVortonMode() {
  const { preferences } = useFormPreferences();
  return preferences.vortonMode === true;
}

export function VortonModeToggle() {
  const { preferences, updatePreferences } = useFormPreferences();
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const enabled = preferences.vortonMode === true;
  const change = useCallback(
    async (vortonMode: boolean) => {
      setSaving(true);
      try {
        await updatePreferences({ vortonMode });
      } catch (error) {
        toast.error(toErrorMessage(error));
      } finally {
        setSaving(false);
      }
    },
    [updatePreferences, toast],
  );
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>Vorton Mode</Text>
        <Text style={settingsStyles.rowHint}>
          {enabled
            ? "On: named presets, usage rails, reset credits, and local-worker supervision."
            : "Off: standard Paseo model, reasoning, and permission controls."}{" "}
          Saved accounts and presets are retained. Applies on this device; running tasks are
          unchanged.
        </Text>
      </View>
      <View style={styles.segmented} testID="settings-vorton-mode">
        {[false, true].map((mode) => (
          <ModeSegment
            key={String(mode)}
            mode={mode}
            enabled={enabled}
            saving={saving}
            change={change}
          />
        ))}
      </View>
    </View>
  );
}

function ModeSegment({
  mode,
  enabled,
  saving,
  change,
}: {
  mode: boolean;
  enabled: boolean;
  saving: boolean;
  change: (mode: boolean) => Promise<void>;
}) {
  const onPress = useCallback(() => void change(mode), [change, mode]);
  const state = useMemo(
    () => ({ selected: enabled === mode, disabled: saving }),
    [enabled, mode, saving],
  );
  return (
    <Pressable
      onPress={onPress}
      disabled={saving}
      accessibilityRole="button"
      dataSet={COMPACT_MODE_SEGMENT}
      accessibilityLabel={mode ? "Vorton mode" : "Paseo mode"}
      accessibilityState={state}
      style={[styles.segment, enabled === mode && styles.selectedSegment]}
    >
      <Text style={[styles.segmentText, enabled === mode && styles.selectedText]}>
        {mode ? "Vorton" : "Paseo"}
      </Text>
    </Pressable>
  );
}
const styles = StyleSheet.create((theme) => ({
  segmented: {
    flexDirection: "row",
    padding: 3,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 9,
    backgroundColor: theme.colors.surface0,
    flexShrink: 0,
  },
  segment: {
    minWidth: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  selectedSegment: { backgroundColor: "#31463a" },
  segmentText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  selectedText: { color: "#e1eee5" },
}));

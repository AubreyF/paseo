import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { StatusBadge } from "@/components/ui/status-badge";
import { piModelFacts } from "./pi-model-facts";
import { filterSelectableModels } from "@/provider-selection/model-catalog";

export function PiModelCatalog({
  entry,
  profileModel,
}: {
  entry: ProviderSnapshotEntry | undefined;
  profileModel: string | undefined;
}) {
  const models = filterSelectableModels(entry?.models ?? null) ?? [];
  return (
    <View style={styles.catalog} testID="pi-model-catalog">
      <View style={styles.headingRow}>
        <Text style={styles.heading}>Models available through Pi</Text>
        <Text style={styles.muted}>{models.length}</Text>
      </View>
      {models.map((model) => {
        const facts = piModelFacts(model);
        const selected =
          model.id === profileModel ||
          Boolean(profileModel && model.aliases?.includes(profileModel));
        return (
          <View
            key={model.id}
            style={[styles.card, selected && styles.selected]}
            testID={`pi-catalog-model-${model.id}`}
          >
            <View style={styles.headingRow}>
              <Text style={styles.name}>{model.label}</Text>
              {selected ? <Text style={styles.selectedLabel}>Profile model</Text> : null}
            </View>
            <Text style={styles.identifier} selectable>
              {model.id}
            </Text>
            {facts.length ? (
              <View style={styles.facts}>
                {facts.map((fact) => (
                  <StatusBadge key={fact} label={fact} />
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
      <Text style={styles.muted}>
        {models.length
          ? "Capabilities and limits reflect Pi’s configuration. Manage profiles to choose a model or add usage notes."
          : "No models reported by Pi. Check the connection in provider settings."}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  catalog: { gap: theme.spacing[2] },
  headingRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  heading: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  name: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  identifier: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  selectedLabel: { color: theme.colors.accent, fontSize: theme.fontSize.sm },
  card: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  selected: { borderColor: theme.colors.accent },
  facts: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1] },
}));

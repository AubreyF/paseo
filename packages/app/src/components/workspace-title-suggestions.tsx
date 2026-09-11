import { useCallback, useRef } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { RenamableWorkspace } from "./workspace-rename-modal";

interface Props {
  workspace: RenamableWorkspace;
  onSelect: (title: string) => void;
  disabled: boolean;
}

export function WorkspaceTitleSuggestions(props: Props) {
  // COMPAT(workspaceTitleSuggestions): added in v0.7.2, remove gate after 2027-03-10.
  const supported = useHostFeature(props.workspace.serverId, "workspaceTitleSuggestions");
  if (!supported) {
    return (
      <Text style={styles.hint}>
        Title suggestions require an updated host with a metadata provider configured.
      </Text>
    );
  }
  return <AvailableSuggestions {...props} />;
}

function AvailableSuggestions({ workspace, onSelect, disabled }: Props) {
  const queryClient = useQueryClient();
  const queryKey = ["workspace-title-suggestions", workspace.serverId, workspace.workspaceId];
  const refreshRequested = useRef(false);
  const cached = queryClient.getQueryState(queryKey);
  const suggestions = useFetchQuery({
    dataShape: "value",
    enabled: !cached?.data || Date.now() - cached.dataUpdatedAt >= 30 * 60_000,
    queryKey,
    queryFn: async () => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) throw new Error("Host disconnected. Reconnect and try again.");
      // Only the Regenerate button requests new alternatives.
      const regenerate = refreshRequested.current;
      refreshRequested.current = false;
      return client.suggestWorkspaceTitles(workspace.workspaceId, regenerate);
    },
    staleTimeMs: 30 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const refetch = suggestions.refetch;
  const regenerate = useCallback(() => {
    refreshRequested.current = true;
    void refetch({ cancelRefetch: false });
  }, [refetch]);
  return (
    <View style={styles.body} testID="workspace-title-suggestions">
      <View style={styles.header}>
        <Text style={styles.hint}>Suggested titles</Text>
        <Button
          variant="ghost"
          size="md"
          onPress={regenerate}
          disabled={disabled || suggestions.isFetching}
          testID="workspace-title-regenerate"
        >
          {suggestions.isError ? "Retry" : "Regenerate"}
        </Button>
      </View>
      {suggestions.isFetching ? (
        <Text style={styles.hint} accessibilityLiveRegion="polite">
          Generating suggestions...
        </Text>
      ) : null}
      {suggestions.isError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {suggestions.error.message}
        </Text>
      ) : null}
      {suggestions.data?.map((title) => (
        <SuggestedTitle key={title} title={title} disabled={disabled} onSelect={onSelect} />
      ))}
    </View>
  );
}

function SuggestedTitle({
  title,
  disabled,
  onSelect,
}: Pick<Props, "disabled" | "onSelect"> & { title: string }) {
  const select = useCallback(() => onSelect(title), [onSelect, title]);
  return (
    <Button
      variant="ghost"
      size="md"
      style={styles.suggestion}
      textStyle={styles.suggestionText}
      disabled={disabled}
      onPress={select}
    >
      {title}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[1] },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  suggestion: { justifyContent: "flex-start", minHeight: 44, height: "auto" },
  suggestionText: { textAlign: "left", flexShrink: 1 },
}));

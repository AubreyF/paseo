import { useCallback, useMemo, useReducer } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { toErrorMessage } from "@/utils/error-messages";

interface HandoffModalProps {
  name: string;
  initialContext: string;
  onClose: () => void;
  onConfirm: (context: string) => Promise<void>;
}
interface FormState {
  context: string;
  pending: boolean;
  error: string | null;
}
type Action =
  | { type: "edit"; context: string }
  | { type: "submit" }
  | { type: "error"; error: string };
function reduce(state: FormState, action: Action): FormState {
  if (action.type === "edit") return { ...state, context: action.context, error: null };
  if (action.type === "submit") return { ...state, pending: true, error: null };
  return { ...state, pending: false, error: action.error };
}
export function ProfileHandoffModal({
  name,
  initialContext,
  onClose,
  onConfirm,
}: HandoffModalProps) {
  const [state, dispatch] = useReducer(reduce, {
    context: initialContext,
    pending: false,
    error: null,
  });
  const header = useMemo(() => ({ title: `Continue with ${name}` }), [name]);
  const edit = useCallback((context: string) => dispatch({ type: "edit", context }), []);
  const close = useCallback(() => {
    if (!state.pending) onClose();
  }, [state.pending, onClose]);
  const submit = useCallback(() => {
    if (state.pending || !state.context.trim()) return;
    dispatch({ type: "submit" });
    void onConfirm(state.context).catch((error) =>
      dispatch({ type: "error", error: toErrorMessage(error) }),
    );
  }, [state.pending, state.context, onConfirm]);
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      desktopMaxWidth={640}
      testID="preset-handoff-modal"
    >
      <View style={styles.body}>
        <Text style={styles.text}>
          Review and edit the handoff before starting a new task. The original stays unchanged. Stop
          its active workers first. The current permission mode is preserved or the launch is
          rejected.
        </Text>
        <Text style={styles.text}>
          This partial record excludes attachments and tool results. Add important decisions,
          changed files and test results here.
        </Text>
        <AdaptiveTextInput
          initialValue={initialContext}
          onChangeText={edit}
          multiline
          maxLength={50_000}
          editable={!state.pending}
          style={styles.input}
          accessibilityLabel="Handoff context"
          testID="preset-handoff-context"
        />
        {state.error ? (
          <Text style={styles.text} accessibilityRole="alert">
            {state.error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button variant="ghost" onPress={close} disabled={state.pending}>
            Cancel
          </Button>
          <Button
            onPress={submit}
            disabled={state.pending || !state.context.trim()}
            testID="preset-handoff-confirm"
          >
            {state.pending ? "Starting…" : "Start successor"}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[3] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  input: {
    minHeight: 220,
    maxHeight: 340,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlignVertical: "top",
  },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));

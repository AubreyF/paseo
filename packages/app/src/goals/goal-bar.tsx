import { useGoalElapsed } from "./use-goal-elapsed";
import { Text, View } from "react-native";
import { useCallback } from "react";
import { Pause, Play, Trash2, Maximize2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useVortonTouch } from "@/vorton-touch";
import { GOAL_STATUS_LABELS, formatGoalElapsed } from "./goal-presentation";
import type { AgentGoalControl } from "./use-agent-goal";

interface GoalBarProps {
  control: AgentGoalControl;
  onExpand: () => void;
}

export function GoalBar({ control, onExpand }: GoalBarProps) {
  const touch = useVortonTouch();
  const mutate = control.mutate;
  const toggle = useCallback(() => {
    const status = control.state?.goal?.status === "active" ? "paused" : "active";
    void mutate({ kind: "set", input: { status } }).catch(() => {});
  }, [mutate, control.state]);
  const clear = useCallback(() => {
    void mutate({ kind: "clear" }).catch(() => {});
  }, [mutate]);
  const elapsed = useGoalElapsed(control.state, control.connected);
  if (!control.supported) return null;
  const goal = control.state?.goal;
  if (!goal && !control.error) return null;
  const paused = goal === null || goal === undefined || goal.status !== "active";
  const action = paused ? "Resume goal" : "Pause goal";
  const label = goalBarLabel(control);

  return (
    <View style={styles.container} testID="agent-goal-bar">
      <View style={styles.row}>
        <View style={styles.copy}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.objective} numberOfLines={1} selectable>
            {goal?.objective}
          </Text>
        </View>
        {goal ? <Text style={styles.elapsed}>{formatGoalElapsed(elapsed)}</Text> : null}
        <Button
          variant="ghost"
          size="sm"
          style={touch ? styles.touch : undefined}
          accessibilityLabel={action}
          testID="agent-goal-pause-resume"
          leftIcon={paused ? playIcon : pauseIcon}
          disabled={!control.canMutate || !goal}
          loading={control.pending}
          onPress={toggle}
        />
        <Button
          variant="ghost"
          size="sm"
          style={touch ? styles.touch : undefined}
          accessibilityLabel="Clear goal"
          testID="agent-goal-clear"
          leftIcon={trashIcon}
          disabled={!control.canMutate || !goal}
          onPress={clear}
        />
        <Button
          variant="ghost"
          size="sm"
          style={touch ? styles.touch : undefined}
          accessibilityLabel="Goal details"
          testID="agent-goal-expand"
          leftIcon={expandIcon}
          onPress={onExpand}
        />
      </View>
      {control.error ? (
        <View style={styles.errorRow}>
          <Text accessibilityRole="alert" style={styles.error}>
            {control.error}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            disabled={!control.connected || control.refreshing}
            onPress={control.refresh}
          >
            Refresh
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function goalBarLabel(control: AgentGoalControl): string {
  if (!control.connected) return "Goal offline";
  if (control.state?.status !== "ready") return "Goal state unconfirmed";
  const goal = control.state.goal;
  return goal ? GOAL_STATUS_LABELS[goal.status] : "No goal";
}

function pauseIcon(color: string) {
  return <Pause size={16} color={color} />;
}
function playIcon(color: string) {
  return <Play size={16} color={color} />;
}
function trashIcon(color: string) {
  return <Trash2 size={16} color={color} />;
}
function expandIcon(color: string) {
  return <Maximize2 size={16} color={color} />;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  copy: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  objective: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  elapsed: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  touch: { minWidth: 44, minHeight: 44 },
  errorRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  error: { flex: 1, color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));

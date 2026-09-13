import { useMemo, type ComponentProps } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";

export function CompactAccountButton({ style, testID, ...props }: ComponentProps<typeof Button>) {
  const outline = useMemo(
    () => <View pointerEvents="none" style={styles.outline} testID={`${testID}-outline`} />,
    [testID],
  );
  return (
    <Button
      {...props}
      testID={testID}
      variant="outline"
      size="xs"
      style={[styles.target, style]}
      trailing={outline}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  // Keep the visible outline compact while retaining a full touch target in the existing row.
  target: {
    height: CONTROL_HEIGHTS.field,
    minHeight: CONTROL_HEIGHTS.field,
    minWidth: CONTROL_HEIGHTS.field,
    borderWidth: 0,
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[2],
  },
  outline: {
    position: "absolute",
    left: 0,
    right: 0,
    top: (CONTROL_HEIGHTS.field - CONTROL_HEIGHTS.tight) / 2,
    height: CONTROL_HEIGHTS.tight,
    borderWidth: 1,
    borderRadius: theme.borderRadius.md,
    borderColor: theme.colors.borderAccent,
  },
}));

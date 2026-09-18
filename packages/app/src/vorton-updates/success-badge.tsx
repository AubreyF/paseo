import { useEffect } from "react";
import { Text, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import Animated, {
  Easing,
  createAnimatedComponent,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

const AnimatedPath = createAnimatedComponent(Path);

function SuccessBadge({ label, color }: { label: string; color: string }) {
  const reducedMotion = useReducedMotion();
  const entrance = useSharedValue(reducedMotion ? 1 : 0);
  const ripple = useSharedValue(reducedMotion ? 1 : 0);
  const check = useSharedValue(reducedMotion ? 0 : 22);
  useEffect(() => {
    if (reducedMotion) return;
    // Match Freed desktop's UpToDateBadge: entrance, expanding ring, then drawn check.
    entrance.value = withTiming(1, { duration: 280, easing: Easing.bezier(0.34, 1.56, 0.64, 1) });
    ripple.value = withDelay(80, withTiming(1, { duration: 550, easing: Easing.out(Easing.ease) }));
    check.value = withDelay(180, withTiming(0, { duration: 380, easing: Easing.out(Easing.ease) }));
  }, [reducedMotion, entrance, ripple, check]);
  const entranceStyle = useAnimatedStyle(() => ({
    opacity: entrance.value,
    transform: [{ translateY: 3 * (1 - entrance.value) }, { scale: 0.94 + 0.06 * entrance.value }],
  }));
  const rippleStyle = useAnimatedStyle(() => ({
    opacity: 0.125 * (1 - ripple.value),
    transform: [{ scale: 1 + ripple.value }],
  }));
  const checkProps = useAnimatedProps(() => ({ strokeDashoffset: check.value }));
  return (
    <Animated.View
      style={[styles.badge, entranceStyle]}
      accessibilityLiveRegion="polite"
      testID="vorton-check-success"
    >
      <View style={styles.icon}>
        <Animated.View style={[styles.ring, { backgroundColor: color }, rippleStyle]} />
        <Svg width={18} height={18} viewBox="0 0 18 18" fill="none">
          <Circle cx={9} cy={9} r={8} stroke={color} strokeOpacity={0.35} strokeWidth={1.5} />
          <AnimatedPath
            d="M5.5 9l2.5 2.5 4.5-5"
            stroke={color}
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="22"
            animatedProps={checkProps}
          />
        </Svg>
      </View>
      <Text style={styles.label}>{label}</Text>
    </Animated.View>
  );
}
export const UpdateSuccessBadge = withUnistyles(SuccessBadge, (theme) => ({
  color: theme.colors.success,
}));
const styles = StyleSheet.create((theme) => ({
  badge: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], minHeight: 44 },
  icon: { width: 18, height: 18, alignItems: "center", justifyContent: "center" },
  ring: { position: "absolute", width: 18, height: 18, borderRadius: 9 },
  label: { fontSize: theme.fontSize.sm, color: theme.colors.success },
}));

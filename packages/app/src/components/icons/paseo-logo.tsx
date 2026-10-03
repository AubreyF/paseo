import { useMemo } from "react";
import { Image } from "react-native";
import { useUnistyles } from "react-native-unistyles";

interface VorteoLogoProps {
  size?: number;
  color?: string;
}

export function VorteoLogo({ size = 64, color }: VorteoLogoProps) {
  const { theme } = useUnistyles();
  const imageStyle = useMemo(
    () => ({ width: size, height: size, ...(color ? { tintColor: color } : {}) }),
    [size, color],
  );
  const lightForeground = parseInt(theme.colors.foreground.slice(1, 3), 16) > 127;
  const source = lightForeground
    ? require("../../../assets/brand/vorteo-white.png")
    : require("../../../assets/brand/vorteo-dark.png");

  return (
    <Image source={source} style={imageStyle} resizeMode="contain" accessibilityLabel="Vorteo" />
  );
}

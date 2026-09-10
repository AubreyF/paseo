import type { AppearanceInput } from "./apply";
export function vortonAppearance(input: AppearanceInput, touch: boolean): AppearanceInput {
  if (!touch) return input;
  return {
    ...input,
    uiBaseFontSize: Math.max(16, input.uiBaseFontSize),
    contentFontSize: Math.max(17, input.contentFontSize),
  };
}

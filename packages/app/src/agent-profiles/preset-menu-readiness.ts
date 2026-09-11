export function presetMenuReady(input: {
  catalogLoading: boolean;
  usageLoading: boolean;
  resets: readonly { enabled: boolean; hasData: boolean; failed: boolean }[];
}): boolean {
  return (
    !input.catalogLoading &&
    !input.usageLoading &&
    input.resets.every((reset) => !reset.enabled || reset.hasData || reset.failed)
  );
}

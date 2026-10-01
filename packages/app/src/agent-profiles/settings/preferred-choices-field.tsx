import { useCallback, useMemo } from "react";
import {
  SelectField,
  type SelectFieldOption,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import { ComboboxItem } from "@/components/ui/combobox";

export function PreferredChoicesField({
  label,
  options,
  preferred,
  onToggle,
  disabled,
}: {
  label: string;
  options: SelectFieldOption<string>[];
  preferred: readonly string[];
  onToggle: (value: string) => void;
  disabled: boolean;
}) {
  const display = useMemo(() => {
    const labels = preferred.map(
      (id) => options.find((option) => option.value === id)?.label ?? id,
    );
    return labels.length ? { label: labels.join(", ") } : null;
  }, [options, preferred]);
  const renderOption = useCallback(
    ({ option, active, onPress }: SelectFieldRenderOptionInput<string>) => (
      <ComboboxItem
        label={option.label}
        selected={preferred.includes(option.value)}
        active={active}
        onPress={onPress}
      />
    ),
    [preferred],
  );
  return (
    <SelectField
      label={label}
      value={null}
      selectedDisplay={display}
      options={options}
      onChange={onToggle}
      renderOption={renderOption}
      placeholder="Choose preferred options"
      emptyText="No catalog choices available"
      disabled={disabled}
      searchable
    />
  );
}

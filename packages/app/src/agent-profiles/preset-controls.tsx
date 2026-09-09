import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { Text, ScrollView, View, useWindowDimensions } from "react-native";
import { EditingTextInput } from "@/components/ui/text-input";
import { StyleSheet } from "react-native-unistyles";
import { SelectField } from "@/components/ui/select-field";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxItem } from "@/components/ui/combobox";
import { suggestPreset } from "./internal/recommendation";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import {
  formatLocalEndpointSummary,
  formatWorkerActivity,
} from "@/provider-usage/local-endpoint-summary";
import type { AgentProfilePicker } from "./internal/use-agent-profile-picker";
import type { AgentModeControlValue } from "@/composer/agent-controls/mode-control";
import { useAgentProfiles } from "./internal/use-agent-profiles";
import { PresetUsageRail } from "./preset-usage-rail";
import { useIsCompactFormFactor } from "@/constants/layout";

interface PresetControlsProps {
  serverId: string | null;
  profiles: AgentProfilePicker;
  selectedProfileId?: string;
  selectedProfileName?: string;
  currentProvider?: string;
  quotaPausedAt?: string;
  modeControl: AgentModeControlValue | null;
  onEdit?: () => void;
  disabled: boolean;
}
export function activePresetPicker(input: {
  enabled?: boolean;
  supported: boolean;
  picker: AgentProfilePicker | null;
}) {
  return input.enabled && input.supported ? input.picker : null;
}
export function PresetControls({
  serverId,
  profiles,
  selectedProfileId,
  selectedProfileName,
  currentProvider,
  quotaPausedAt,
  modeControl,
  onEdit,
  disabled,
}: PresetControlsProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [inspectedId, setInspectedId] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const anchorRef = useRef<View>(null);
  const isCompact = useIsCompactFormFactor();
  const { width } = useWindowDimensions();
  const { profiles: definitions } = useAgentProfiles(serverId);
  const hasLocalEndpoint = profiles.rows.some((row) => Boolean(row.localEndpoint));
  const { view } = useProviderUsage(serverId, { enabled: open, pollActivity: open });
  // Probe only while open; changing snapshots must not restart the refresh loop.
  const refreshRef = useRef(profiles.refreshStatus);
  refreshRef.current = profiles.refreshStatus;
  const refreshingRef = useRef(profiles.isRefreshingStatus);
  refreshingRef.current = profiles.isRefreshingStatus;
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (!open) return;
    const tick = () => {
      const timestamp = Date.now();
      setNow(timestamp);
      if (hasLocalEndpoint && !refreshingRef.current && timestamp - lastRefresh.current >= 60_000) {
        lastRefresh.current = timestamp;
        refreshRef.current?.();
      }
    };
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [open, hasLocalEndpoint, serverId]);
  const options = useMemo(
    () =>
      profiles.rows
        .filter((row) => `${row.name} ${row.summary}`.toLowerCase().includes(query.toLowerCase()))
        .map((row) => ({ id: row.id, label: row.name })),
    [profiles.rows, query],
  );
  const visibleRows = profiles.rows.filter((row) =>
    `${row.name} ${row.summary}`.toLowerCase().includes(query.toLowerCase()),
  );
  const inspected =
    profiles.rows.find((row) => row.id === (inspectedId ?? selectedProfileId)) ?? visibleRows[0];
  const definition = definitions?.find((row) => row.id === inspected?.id);
  const worker = definitions?.find((row) => row.id === definition?.workerProfileId);
  const selected = profiles.rows.find((row) => row.id === selectedProfileId);
  const triggerLabel = selectedProfileName ?? selected?.name ?? "Custom configuration";
  const suggestion =
    quotaPausedAt && view.kind === "ready"
      ? suggestPreset(profiles.rows, currentProvider, view.payload.providers)
      : undefined;
  const show = useCallback(() => {
    setInspectedId(selectedProfileId);
    setQuery("");
    setOpen(true);
  }, [selectedProfileId]);
  const select = useCallback(
    (id: string) => {
      if (disabled || profiles.isApplying) return;
      setInspectedId(id);
      profiles.applyProfile(id);
    },
    [disabled, profiles],
  );
  const edit = useCallback(() => {
    setOpen(false);
    onEdit?.();
  }, [onEdit]);
  const footer = useMemo(
    () =>
      onEdit ? (
        <Button variant="ghost" size="sm" textStyle={styles.meta} onPress={edit}>
          Manage presets
        </Button>
      ) : null,
    [onEdit, edit],
  );
  const renderRail = (row: AgentProfilePicker["rows"][number]) => (
    <PresetUsageRail
      usage={
        view.kind === "ready"
          ? view.payload.providers.find((entry) => entry.providerId === row.provider)
          : undefined
      }
      localStatus={
        row.localEndpoint
          ? `${formatLocalEndpointSummary(row.localEndpoint, now)} · ${formatWorkerActivity(view.kind === "ready" ? view.payload.workerActivity : undefined, row.provider, now)}`
          : undefined
      }
      serverId={serverId}
      providerId={row.provider}
      name={row.name}
    />
  );
  return (
    <View style={styles.controls}>
      {quotaPausedAt ? (
        <Text style={styles.notice} accessibilityRole="alert">
          Quota exhausted. New turns are blocked.{" "}
          {suggestion ? `Suggested preset: ${suggestion.name}.` : "Choose another preset."} Confirm
          a new task to continue.
        </Text>
      ) : null}
      <View ref={anchorRef} collapsable={false} style={styles.trigger}>
        <Button
          variant="ghost"
          style={styles.toolbarTrigger}
          textStyle={styles.toolbarText}
          size="sm"
          onPress={show}
          disabled={disabled || profiles.isApplying}
          accessibilityLabel={`Preset (${triggerLabel})`}
          testID="agent-preset-selector"
        >
          {triggerLabel} ⌄
        </Button>
      </View>
      <Combobox
        options={options}
        value={selectedProfileId ?? ""}
        onSelect={select}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        title="Presets"
        onActiveOptionChange={setInspectedId}
        desktopPlacement="top-start"
        desktopMinWidth={Math.min(760, width - 32)}
        desktopFixedHeight={380}
        desktopChildrenScrollEnabled={false}
        keepOpenOnSelect
      >
        <View style={isCompact || width < 760 ? styles.stacked : styles.split}>
          <View style={styles.list}>
            <EditingTextInput
              initialValue={query}
              onChangeText={setQuery}
              placeholder="Search presets"
              accessibilityLabel="Search presets"
              style={styles.search}
              autoFocus
            />
            <ScrollView style={styles.rows} keyboardShouldPersistTaps="handled">
              {visibleRows.map((row) => (
                <PresetRow
                  key={row.id}
                  row={row}
                  rail={renderRail(row)}
                  selected={row.id === selectedProfileId}
                  active={row.id === inspected?.id}
                  disabled={disabled || profiles.isApplying}
                  onSelect={select}
                />
              ))}
              {!visibleRows.length ? <Text style={styles.meta}>No matching presets</Text> : null}
            </ScrollView>
            <View style={styles.manage}>{footer}</View>
          </View>
          {inspected ? (
            <PresetInspector
              row={inspected}
              definition={definition}
              worker={worker}
              rail={renderRail(inspected)}
            />
          ) : null}
        </View>
      </Combobox>
      <PresetPermissions modeControl={modeControl} disabled={disabled} />
    </View>
  );
}
function PresetPermissions({
  modeControl,
  disabled,
}: {
  modeControl: AgentModeControlValue | null;
  disabled: boolean;
}) {
  return modeControl ? (
    <SelectField
      label="Permissions"
      toolbar
      triggerTextStyle={styles.toolbarText}
      size="sm"
      desktopPlacement="top-start"
      field={false}
      value={modeControl.selectedModeId ?? null}
      selectedDisplay={
        modeControl.modeOptions.find((entry) => entry.id === modeControl.selectedModeId) ?? null
      }
      options={modeControl.modeOptions.map((entry) => ({
        id: entry.id,
        value: entry.id,
        label: entry.label,
      }))}
      onChange={modeControl.onSelectMode}
      disabled={disabled}
      placeholder="Permissions"
      emptyText="No permission modes"
    />
  ) : (
    <Text style={styles.meta}>No provider permission modes</Text>
  );
}
function PresetRow({
  row,
  rail,
  selected,
  active,
  disabled,
  onSelect,
}: {
  row: AgentProfilePicker["rows"][number];
  rail: ReactNode;
  selected: boolean;
  active: boolean;
  disabled?: boolean;
  onSelect: (id: string) => void;
}) {
  const press = useCallback(() => onSelect(row.id), [onSelect, row.id]);
  return (
    <ComboboxItem
      style={styles.row}
      labelStyle={styles.text}
      label={row.name}
      descriptionPlacement="below"
      descriptionSlot={rail}
      selectionPlacement="leading"
      selected={selected}
      active={active}
      disabled={disabled}
      onPress={press}
    />
  );
}
function PresetInspector({
  row,
  definition,
  worker,
  rail,
}: {
  row: AgentProfilePicker["rows"][number];
  definition?: AgentProfile;
  worker?: AgentProfile;
  rail: ReactNode;
}) {
  let execution = "Direct provider session. No configured workers.";
  if (row.localEndpoint) execution = "Local inference through Pi.";
  if (worker)
    execution = `Supervises ${worker.name}. Up to ${definition?.maxWorkers ?? 2} local workers.`;
  return (
    <ScrollView style={styles.inspector} contentContainerStyle={styles.inspectorContent}>
      <Text style={styles.title}>{row.name}</Text>
      {rail}
      <Text style={styles.label}>Configuration</Text>
      <Text style={styles.text}>{row.summary}</Text>
      <Text style={styles.label}>Execution</Text>
      <Text style={styles.text}>{execution}</Text>
      <Text style={styles.label}>Instructions</Text>
      <Text style={styles.text}>
        {definition?.instructions?.trim() || "No preset-specific instructions."}
      </Text>
      {!row.localEndpoint ? (
        <>
          <Text style={styles.label}>On quota exhaustion</Text>
          <Text style={styles.text}>
            Stop and suggest another preset. Never switch automatically.
          </Text>
        </>
      ) : null}
    </ScrollView>
  );
}
const styles = StyleSheet.create((theme) => ({
  controls: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  trigger: { minWidth: 0, maxWidth: 360, flexShrink: 1 },
  toolbarText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  toolbarTrigger: {
    height: 28,
    minHeight: 28,
    paddingHorizontal: theme.spacing[2],
    borderWidth: 0,
    borderRadius: theme.borderRadius["2xl"],
  },
  split: { flex: 1, minHeight: 0, flexDirection: "row", alignItems: "stretch" },
  row: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    minHeight: 68,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  stacked: { flex: 1, flexDirection: "column" },
  list: { flex: 1, minWidth: 0, borderRightWidth: 1, borderRightColor: theme.colors.border },
  rows: { flex: 1, minHeight: 0 },
  search: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    padding: theme.spacing[4],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  manage: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  inspector: {
    flex: 1,
    minWidth: 0,
    backgroundColor: theme.colors.surface2,
  },
  inspectorContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  title: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  text: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  label: {
    marginTop: theme.spacing[4],
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  meta: { fontSize: theme.fontSize.base, color: theme.colors.foregroundMuted },
  notice: { width: "100%", fontSize: theme.fontSize.sm, color: theme.colors.foreground },
}));

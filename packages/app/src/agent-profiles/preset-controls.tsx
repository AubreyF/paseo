import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { Text, ScrollView, View, useWindowDimensions } from "react-native";
import { EditingTextInput } from "@/components/ui/text-input";
import { StyleSheet } from "react-native-unistyles";
import { SelectField } from "@/components/ui/select-field";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxItem, SearchInput } from "@/components/ui/combobox";
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
import { useVortonMode } from "@/vorton-mode";
import { useVortonTouch } from "@/vorton-touch";
import { useCompactPermission } from "./use-compact-permission";
import { presetNickname } from "./nickname";
import { permissionCaption } from "./permission-caption";
import { RemainingRing } from "@/provider-usage/remaining-ring";
import { selectedPresetPresentation } from "./selected-preset-presentation";

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
  modeControl,
  onEdit,
  disabled,
}: PresetControlsProps) {
  const [open, setOpen] = useState(false);
  const vortonMode = useVortonMode();
  const touch = useVortonTouch();
  const controlsRef = useRef<View>(null);
  const fullPermissionCaption = permissionCaption(
    modeControl?.modeOptions.find((entry) => entry.id === modeControl.selectedModeId)?.label ??
      "Permissions",
    vortonMode,
  );
  const triggerAccessibilityState = useMemo(() => ({ expanded: open }), [open]);
  const [query, setQuery] = useState("");
  const [inspectedId, setInspectedId] = useState<string>();
  const [now, setNow] = useState(Date.now);
  const anchorRef = useRef<View>(null);
  const isCompact = useIsCompactFormFactor();
  const { width } = useWindowDimensions();
  const { profiles: definitions } = useAgentProfiles(serverId);
  const hasLocalEndpoint = profiles.rows.some((row) => Boolean(row.localEndpoint));
  const { view } = useProviderUsage(serverId, {
    enabled: vortonMode && (open || Boolean(selectedProfileId)),
    pollActivity: open,
    pollUsage: Boolean(selectedProfileId),
  });
  // Probe only while open; changing snapshots must not restart the refresh loop.
  const refreshRef = useRef(profiles.refreshStatus);
  refreshRef.current = profiles.refreshStatus;
  const refreshingRef = useRef(profiles.isRefreshingStatus);
  refreshingRef.current = profiles.isRefreshingStatus;
  const lastRefresh = useRef(0);
  useEffect(() => {
    if (!vortonMode || (!open && !selectedProfileId)) return;
    const tick = () => {
      const timestamp = Date.now();
      setNow(timestamp);
      if (
        open &&
        hasLocalEndpoint &&
        !refreshingRef.current &&
        timestamp - lastRefresh.current >= 60_000
      ) {
        lastRefresh.current = timestamp;
        refreshRef.current?.();
      }
    };
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [open, hasLocalEndpoint, serverId, selectedProfileId, vortonMode]);
  const visibleRows = useMemo(
    () =>
      profiles.rows.filter((row) => {
        const nickname = presetNickname({
          name: row.name,
          nickname: definitions?.find((entry) => entry.id === row.id)?.nickname,
        });
        return `${row.name} ${row.summary} ${nickname}`.toLowerCase().includes(query.toLowerCase());
      }),
    [profiles.rows, query, definitions],
  );
  const options = useMemo(
    () => visibleRows.map((row) => ({ id: row.id, label: row.name })),
    [visibleRows],
  );
  const inspected =
    profiles.rows.find((row) => row.id === (inspectedId ?? selectedProfileId)) ?? visibleRows[0];
  const definition = definitions?.find((row) => row.id === inspected?.id);
  const worker = definitions?.find((row) => row.id === definition?.workerProfileId);
  const selected = profiles.rows.find((row) => row.id === selectedProfileId);
  const { triggerLabel, showRing, remaining, accessibilityLabel } = selectedPresetPresentation({
    selectedProfileId,
    selectedProfileName,
    currentProvider,
    selected,
    definitions,
    vortonMode,
    view,
    now,
  });
  const compactPermission = useCompactPermission(
    controlsRef,
    touch,
    fullPermissionCaption,
    triggerLabel,
  );
  const permissionControl = (
    <PresetPermissions modeControl={modeControl} disabled={disabled} compact={compactPermission} />
  );
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
    <View
      ref={controlsRef}
      style={[styles.controls, touch && styles.touchControls]}
      testID="preset-controls"
    >
      <View ref={anchorRef} collapsable={false} style={styles.trigger}>
        <ComboboxTrigger
          style={styles.toolbarTrigger}
          accessibilityRole="button"
          accessibilityState={triggerAccessibilityState}
          onPress={show}
          disabled={disabled || profiles.isApplying}
          accessibilityLabel={accessibilityLabel}
          testID="agent-preset-selector"
        >
          {showRing ? (
            <View style={styles.ring}>
              <RemainingRing remaining={remaining} />
            </View>
          ) : null}
          <Text style={styles.toolbarText} numberOfLines={1}>
            {triggerLabel}
          </Text>
        </ComboboxTrigger>
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
            {vortonMode ? (
              <SearchInput placeholder="Search presets" onChangeText={setQuery} autoFocus />
            ) : (
              <EditingTextInput
                initialValue={query}
                onChangeText={setQuery}
                placeholder="Search presets"
                accessibilityLabel="Search presets"
                style={styles.search}
                autoFocus
              />
            )}
            <ScrollView style={styles.rows} keyboardShouldPersistTaps="handled">
              {visibleRows.map((row) => (
                <PresetRow
                  key={row.id}
                  row={row}
                  nickname={
                    vortonMode
                      ? presetNickname({
                          name: row.name,
                          nickname: definitions?.find((entry) => entry.id === row.id)?.nickname,
                        })
                      : undefined
                  }
                  rail={renderRail(row)}
                  selected={row.id === selectedProfileId}
                  active={row.id === inspected?.id}
                  disabled={disabled || profiles.isApplying}
                  onSelect={select}
                />
              ))}
              {!visibleRows.length ? <Text style={styles.meta}>No matching presets</Text> : null}
            </ScrollView>
            <View style={[styles.manage, vortonMode && styles.manageVorton]}>{footer}</View>
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
      {touch ? <View style={styles.touchPermissions}>{permissionControl}</View> : permissionControl}
    </View>
  );
}
function PresetPermissions({
  modeControl,
  disabled,
  compact,
}: {
  modeControl: AgentModeControlValue | null;
  disabled: boolean;
  compact: boolean;
}) {
  const vortonMode = useVortonMode();
  const selectedMode = modeControl?.modeOptions.find(
    (entry) => entry.id === modeControl.selectedModeId,
  );
  const selectedDisplay = useMemo(
    () =>
      selectedMode
        ? { ...selectedMode, label: permissionCaption(selectedMode.label, vortonMode, compact) }
        : null,
    [selectedMode, vortonMode, compact],
  );
  const selectMode = useCallback(
    (modeId: string) => modeControl?.onSelectMode(modeId),
    [modeControl],
  );
  return (
    <SelectField
      label="Permissions"
      accessibilityLabel={
        modeControl
          ? `Permissions (${selectedMode?.label ?? "Permissions"})`
          : "Permission modes unavailable"
      }
      triggerTestID="preset-permission-trigger"
      toolbar
      triggerTextStyle={styles.toolbarText}
      size="sm"
      desktopPlacement="top-start"
      field={false}
      value={modeControl?.selectedModeId ?? null}
      selectedDisplay={selectedDisplay}
      options={(modeControl?.modeOptions ?? []).map((entry) => ({
        id: entry.id,
        value: entry.id,
        label: entry.label,
      }))}
      onChange={selectMode}
      disabled={disabled || !modeControl || modeControl.disabled}
      placeholder={permissionCaption("Permissions", vortonMode, compact)}
      emptyText="No permission modes"
    />
  );
}
function PresetRow({
  row,
  nickname,
  rail,
  selected,
  active,
  disabled,
  onSelect,
}: {
  row: AgentProfilePicker["rows"][number];
  nickname?: string;
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
      label={nickname ? `${nickname} · ${row.name}` : row.name}
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
  const vortonMode = useVortonMode();
  return (
    <ScrollView
      style={[styles.inspector, vortonMode && styles.inspectorVorton]}
      contentContainerStyle={styles.inspectorContent}
    >
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
  touchControls: { flex: 1, flexWrap: "nowrap" },
  touchPermissions: { flexShrink: 0 },
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
    justifyContent: "center",
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
  ring: { marginRight: theme.spacing[1] },
  manageVorton: { padding: theme.spacing[3] },
  inspectorVorton: { backgroundColor: theme.colors.surface1 },
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

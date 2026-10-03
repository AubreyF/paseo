import { ExecutionEnvironmentIcon } from "@/execution-installation/environment-icon";
import { useVortonTouch } from "@/vorton-touch";
import { CONTROL_HEIGHTS } from "@/components/ui/control-geometry";
import { sharedChoiceState, type LaunchChoices } from "./shared-choices";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Keyboard, ScrollView, StyleSheet as RNStyleSheet, Text, View } from "react-native";
import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { ArrowLeft } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProfile, ProviderPreferences } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { Button } from "@/components/ui/button";
import { ComboboxItem, SearchInput } from "@/components/ui/combobox";
import { PiModelCatalog } from "./pi-model-catalog";
import { ProfileDetailsView } from "./profile-details-view";
import { intelligenceLabel, type AccountPresets } from "./account-presets";
import type { AgentProfilePickerRow } from "./internal/use-agent-profile-picker";
import {
  isSharedWorkflowProfile,
  resolveProviderType,
  sharedWorkflowProfileId,
} from "@getpaseo/protocol/provider-preferences";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { SelectField, type SelectFieldRenderOptionInput } from "@/components/ui/select-field";

import Animated, {
  SlideInLeft,
  SlideInRight,
  SlideOutLeft,
  SlideOutRight,
} from "react-native-reanimated";

const enterList = SlideInLeft.duration(220);
const exitList = SlideOutLeft.duration(220);
const enterDetails = SlideInRight.duration(220);
const exitDetails = SlideOutRight.duration(220);

interface AccountPresetMenuProps {
  serverId: string | null;
  accounts: AccountPresets[];
  definitions: readonly AgentProfile[];
  entries: ProviderSnapshotEntry[] | undefined;
  inspectedId: string | undefined;
  selectedId: string | undefined;
  compact: boolean;
  disabled: boolean;
  currentProvider?: string;
  currentModel?: string | null;
  currentThinkingOptionId?: string | null;
  onInspect: (id: string) => void;
  onApply: (id: string, choices?: LaunchChoices) => void;
  onManage: () => void;
  onSearch: (query: string) => void;
  renderRail: (row: AgentProfilePickerRow) => ReactNode;
}

export function AccountPresetMenu(props: AccountPresetMenuProps) {
  const { accounts, inspectedId, selectedId, compact, onInspect } = props;
  const touch = useVortonTouch();
  const headerSize = touch ? "md" : "sm";
  const [detailsOpen, setDetailsOpen] = useState(false);
  const showDetails = compact && detailsOpen;
  const back = useCallback(() => setDetailsOpen(false), []);
  const account =
    accounts.find((group) => group.rows.some((row) => row.id === inspectedId)) ?? accounts[0];
  const inspected = account?.rows.find((row) => row.id === inspectedId) ?? account?.rows[0];
  const { choices, changeChoices, preferences, family, retainWorkflow } = useSharedChoices(
    props,
    account,
  );
  const inspectAccount = useCallback(
    (id: string) => {
      onInspect(retainWorkflow(id));
      if (compact) {
        Keyboard.dismiss();
        setDetailsOpen(true);
      }
    },
    [compact, onInspect, retainWorkflow],
  );

  const details =
    account && inspected ? (
      <AccountChoices
        {...props}
        account={account}
        inspected={inspected}
        choices={choices}
        onChoices={changeChoices}
        preferences={preferences}
        family={family}
      />
    ) : null;
  const AccountScrollView = compact ? BottomSheetScrollView : ScrollView;
  const list = (
    <AccountScrollView
      style={compact ? styles.compactList : styles.list}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {accounts.map((group) => (
        <View key={group.provider} style={styles.account}>
          <AccountButton
            serverId={props.serverId}
            group={group}
            active={!compact && group === account}
            selectedId={selectedId}
            onInspect={inspectAccount}
            renderRail={props.renderRail}
          />
        </View>
      ))}
      {!accounts.length ? <Text style={styles.empty}>No matching accounts</Text> : null}
    </AccountScrollView>
  );
  return (
    <View style={styles.root} testID="account-preset-menu">
      <View style={styles.header}>
        <View style={styles.search}>
          {showDetails ? (
            <Button
              variant="ghost"
              size={headerSize}
              leftIcon={ArrowLeft}
              onPress={back}
              style={styles.back}
              testID="preset-accounts-back"
              accessibilityLabel="Back to connections"
            >
              Back
            </Button>
          ) : null}
          <View style={showDetails ? styles.hidden : styles.searchField}>
            <SearchInput
              size={headerSize}
              placeholder="Search accounts"
              onChangeText={props.onSearch}
              autoFocus={!compact}
            />
          </View>
        </View>
        <Button
          variant="outline"
          size={headerSize}
          onPress={props.onManage}
          testID="preset-manage-profiles"
        >
          Manage profiles
        </Button>
      </View>
      {compact ? (
        <View style={styles.pages}>
          {showDetails ? (
            <Animated.View
              key="details"
              entering={enterDetails}
              exiting={exitDetails}
              style={RNStyleSheet.absoluteFill}
            >
              <View style={styles.detail} testID="preset-connection-details">
                {details}
              </View>
            </Animated.View>
          ) : (
            <Animated.View
              key="accounts"
              entering={enterList}
              exiting={exitList}
              style={RNStyleSheet.absoluteFill}
            >
              {list}
            </Animated.View>
          )}
        </View>
      ) : (
        <View style={styles.split}>
          {list}
          <View style={styles.detail}>{details}</View>
        </View>
      )}
    </View>
  );
}

function useSharedChoices(props: AccountPresetMenuProps, account: AccountPresets | undefined) {
  const [choicesByType, setChoicesByType] = useState<Record<string, LaunchChoices>>({});
  const { config } = useDaemonConfig(props.serverId);
  const providerType = account
    ? resolveProviderType(account.provider, config?.providers ?? {})
    : "";
  const selected = props.definitions.find((profile) => profile.id === props.selectedId);
  const currentProvider = props.currentProvider ?? selected?.provider;
  const selectedType = currentProvider
    ? resolveProviderType(currentProvider, config?.providers ?? {})
    : null;
  const seedChoices =
    selectedType === providerType
      ? {
          model: props.currentModel === null ? "" : props.currentModel,
          thinkingOptionId:
            props.currentThinkingOptionId === null ? "" : props.currentThinkingOptionId,
        }
      : {};
  const choices = choicesByType[providerType] ?? seedChoices;
  const changeChoices = useCallback(
    (next: LaunchChoices) => {
      setChoicesByType((current) => ({ ...current, [providerType]: next }));
    },
    [providerType],
  );
  const family = useMemo(
    () =>
      (props.entries ?? []).filter(
        (entry) => resolveProviderType(entry.provider, config?.providers ?? {}) === providerType,
      ),
    [props.entries, config, providerType],
  );
  const preferences = config?.sharedProviderPreferences?.providers[providerType];
  const retainWorkflow = useCallback(
    (id: string) => {
      const target = props.definitions.find((profile) => profile.id === id);
      const current = props.definitions.find(
        (profile) => profile.id === (props.inspectedId ?? props.selectedId),
      );
      if (!target || !current || !isSharedWorkflowProfile(current.id)) return id;
      const ancestry = config?.providers ?? {};
      if (
        resolveProviderType(target.provider, ancestry) !==
        resolveProviderType(current.provider, ancestry)
      )
        return id;
      const matching = sharedWorkflowProfileId(
        target.provider,
        decodeURIComponent(current.id.split("/")[2]),
      );
      return props.definitions.some((profile) => profile.id === matching) ? matching : id;
    },
    [props.definitions, props.inspectedId, props.selectedId, config],
  );
  return { choices, changeChoices, preferences, family, retainWorkflow };
}

function AccountButton({
  serverId,
  group,
  active,
  selectedId,
  onInspect,
  renderRail,
}: {
  serverId: string | null;
  group: AccountPresets;
  active: boolean;
  selectedId: string | undefined;
  onInspect: (id: string) => void;
  renderRail: AccountPresetMenuProps["renderRail"];
}) {
  const select = useCallback(
    () => onInspect(group.rows.find((row) => row.id === selectedId)?.id ?? group.rows[0].id),
    [group, selectedId, onInspect],
  );
  const environmentIcon = useMemo(
    () => <ExecutionEnvironmentIcon serverId={serverId} />,
    [serverId],
  );
  const usage = useMemo(
    () => <View style={styles.usage}>{renderRail(group.rows[0])}</View>,
    [group, renderRail],
  );
  return (
    <ComboboxItem
      leadingSlot={environmentIcon}
      descriptionSlot={usage}
      descriptionPlacement="below"
      labelNumberOfLines={1}
      label={group.label}
      labelStyle={styles.accountTitle}
      active={active}
      selectionPlacement="trailing"
      selectionIndicatorSize={24}
      selected={group.rows.some((row) => row.id === selectedId)}
      onPress={select}
      style={styles.accountButton}
      testID={`preset-account-${group.provider}`}
    />
  );
}

function AccountChoices({
  account,
  inspected,
  choices,
  onChoices,
  preferences,
  family,
  ...props
}: AccountPresetMenuProps & {
  account: AccountPresets;
  inspected: AgentProfilePickerRow;
  choices: LaunchChoices;
  onChoices: (choices: LaunchChoices) => void;
  preferences: ProviderPreferences | undefined;
  family: ProviderSnapshotEntry[];
}) {
  const DetailScrollView = props.compact ? BottomSheetScrollView : ScrollView;
  const entry = props.entries?.find((candidate) => candidate.provider === account.provider);
  const definition = props.definitions.find((profile) => profile.id === inspected.id);
  const shared = isSharedWorkflowProfile(inspected.id);
  const selection = useMemo(
    () =>
      definition
        ? sharedChoiceState({ profile: definition, choices, entry, preferences, family })
        : null,
    [definition, choices, entry, preferences, family],
  );
  const selectionUnavailable = shared && Boolean(selection?.unavailable);
  const { onApply } = props;
  const apply = useCallback(
    () => onApply(inspected.id, shared ? selection?.choices : undefined),
    [onApply, inspected.id, shared, selection],
  );
  return (
    <View style={styles.detail} testID={`preset-choices-${account.provider}`}>
      <DetailScrollView
        style={styles.detailScroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.choices}>
          <Text style={styles.heading}>{account.label}</Text>
          {props.compact && !inspected.localEndpoint ? props.renderRail(inspected) : null}
          {shared && selection ? (
            <SharedChoiceFields selection={selection} onChoices={onChoices} />
          ) : null}
          <View style={styles.options}>
            {account.rows.map((row) => (
              <ProfileChoice
                key={row.id}
                row={row}
                definition={props.definitions.find((profile) => profile.id === row.id)}
                entry={entry}
                active={row.id === inspected.id}
                disabled={props.disabled || Boolean(row.unavailable)}
                onInspect={props.onInspect}
              />
            ))}
          </View>
          {!shared ? <Text style={styles.summary}>{inspected.summary}</Text> : null}
          {inspected.localEndpoint ? props.renderRail(inspected) : null}
          {account.provider === "pi" ? (
            <PiModelCatalog entry={entry} profileModel={definition?.model} />
          ) : null}
          {definition ? (
            <ProfileDetailsView serverId={props.serverId} profile={definition} compact />
          ) : null}
          <WorkflowInstructions definition={definition} definitions={props.definitions} />
        </View>
      </DetailScrollView>
      <View style={styles.footer}>
        <Button
          variant="default"
          size="md"
          disabled={props.disabled || inspected.unavailable || selectionUnavailable}
          onPress={apply}
          testID="preset-use-profile"
        >
          Use profile
        </Button>
      </View>
    </View>
  );
}

function WorkflowInstructions({
  definition,
  definitions,
}: {
  definition: AgentProfile | undefined;
  definitions: readonly AgentProfile[];
}) {
  return (
    <>
      {definition?.instructions ? (
        <>
          <Text style={styles.label}>Instructions</Text>
          <Text style={styles.summary}>{definition.instructions}</Text>
        </>
      ) : null}
      {definition?.workerProfileId ? (
        <>
          <Text style={styles.label}>Workers</Text>
          <Text style={styles.summary}>
            {definitions.find((profile) => profile.id === definition.workerProfileId)?.name ??
              definition.workerProfileId}{" "}
            · Up to {definition.maxWorkers ?? 2}
          </Text>
        </>
      ) : null}
    </>
  );
}

function SharedChoiceFields({
  selection,
  onChoices,
}: {
  selection: ReturnType<typeof sharedChoiceState>;
  onChoices: (choices: LaunchChoices) => void;
}) {
  const selectModel = useCallback(
    (model: string) => onChoices({ ...selection.choices, model }),
    [selection, onChoices],
  );
  const selectThinking = useCallback(
    (thinkingOptionId: string) => onChoices({ ...selection.choices, thinkingOptionId }),
    [selection, onChoices],
  );
  const renderModel = useCallback(
    ({ option, selected, active, onPress }: SelectFieldRenderOptionInput<string>) => {
      const available =
        selection.modelOptions.find((item) => item.id === option.id)?.available === true;
      return (
        <ComboboxItem
          label={option.label}
          description={available ? undefined : "Unavailable on this account"}
          selected={selected}
          active={active}
          disabled={!available}
          onPress={onPress}
        />
      );
    },
    [selection.modelOptions],
  );
  const renderThinking = useCallback(
    ({ option, selected, active, onPress }: SelectFieldRenderOptionInput<string>) => {
      const available =
        selection.thinkingOptions.find((item) => item.id === option.id)?.available === true;
      return (
        <ComboboxItem
          label={option.label}
          description={available ? undefined : "Unavailable on this account"}
          selected={selected}
          active={active}
          disabled={!available}
          onPress={onPress}
        />
      );
    },
    [selection.thinkingOptions],
  );
  return (
    <>
      <SelectField
        label="Model"
        value={selection.choices.model}
        selectedDisplay={selection.modelDisplay}
        options={selection.modelOptions}
        renderOption={renderModel}
        onChange={selectModel}
        placeholder="Select model"
        emptyText="No models available"
        searchable
        size="md"
        triggerTestID="shared-model-trigger"
        error={selection.modelError}
      />
      <SelectField
        label="Reasoning"
        value={selection.choices.thinkingOptionId}
        selectedDisplay={selection.thinkingDisplay}
        options={selection.thinkingOptions}
        renderOption={renderThinking}
        onChange={selectThinking}
        placeholder="Provider default"
        emptyText="No reasoning choices"
        size="md"
        triggerTestID="shared-thinking-trigger"
        error={selection.thinkingError}
      />
      <Text style={styles.label}>Workflow</Text>
    </>
  );
}

function ProfileChoice({
  row,
  definition,
  entry,
  active,
  disabled,
  onInspect,
}: {
  row: AgentProfilePickerRow;
  definition: AgentProfile | undefined;
  entry: ProviderSnapshotEntry | undefined;
  active: boolean;
  disabled: boolean;
  onInspect: (id: string) => void;
}) {
  const inspect = useCallback(() => onInspect(row.id), [onInspect, row.id]);
  return (
    <View style={[styles.option, active && styles.activeOption]}>
      <ComboboxItem
        label={isSharedWorkflowProfile(row.id) ? row.name : intelligenceLabel(definition, entry)}
        description={isSharedWorkflowProfile(row.id) ? undefined : row.name}
        descriptionPlacement="below"
        selected={active}
        onPress={inspect}
        disabled={disabled}
        style={styles.choiceButton}
        testID={`preset-row-${row.id}`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  search: { flex: 1, minWidth: 0 },
  split: { flex: 1, minHeight: 0, flexDirection: "row" },
  pages: { flex: 1, minHeight: 0, overflow: "hidden" },
  hidden: { display: "none" },
  searchField: { flex: 1 },
  back: { alignSelf: "flex-start" },
  list: {
    width: "44%",
    flexGrow: 0,
    flexShrink: 0,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  compactList: { flex: 1 },
  detail: { flex: 1, backgroundColor: theme.colors.surface1 },
  account: {
    padding: theme.spacing[1],
  },
  accountButton: {
    minHeight: Math.ceil(theme.fontSize.base * 1.4) + CONTROL_HEIGHTS.field + theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingRight: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  accountTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  usage: {
    minHeight: CONTROL_HEIGHTS.field,
    justifyContent: "center",
  },
  detailScroll: { flex: 1, minHeight: 0 },
  footer: { padding: theme.spacing[4], borderTopWidth: 1, borderTopColor: theme.colors.border },
  choices: { padding: theme.spacing[4], gap: theme.spacing[3] },
  heading: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  label: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  summary: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  options: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  option: {
    flexGrow: 1,
    flexBasis: 120,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  activeOption: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.interactionHighlight,
  },
  choiceButton: { minHeight: 64 },
  empty: {
    padding: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));

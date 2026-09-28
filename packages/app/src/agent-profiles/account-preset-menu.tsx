import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Keyboard, ScrollView, StyleSheet as RNStyleSheet, Text, View } from "react-native";
import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { ArrowLeft } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { Button } from "@/components/ui/button";
import { ComboboxItem, SearchInput } from "@/components/ui/combobox";
import { ProfileDetailsView } from "./profile-details-view";
import { intelligenceLabel, type AccountPresets } from "./account-presets";
import type { AgentProfilePickerRow } from "./internal/use-agent-profile-picker";

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
  onInspect: (id: string) => void;
  onApply: (id: string) => void;
  onManage: () => void;
  onSearch: (query: string) => void;
  renderRail: (row: AgentProfilePickerRow) => ReactNode;
}

export function AccountPresetMenu(props: AccountPresetMenuProps) {
  const { accounts, inspectedId, selectedId, compact, onInspect } = props;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const showDetails = compact && detailsOpen;
  const inspectAccount = useCallback(
    (id: string) => {
      onInspect(id);
      if (compact) {
        Keyboard.dismiss();
        setDetailsOpen(true);
      }
    },
    [compact, onInspect],
  );
  const back = useCallback(() => setDetailsOpen(false), []);
  const account =
    accounts.find((group) => group.rows.some((row) => row.id === inspectedId)) ?? accounts[0];
  const inspected = account?.rows.find((row) => row.id === inspectedId) ?? account?.rows[0];
  const details =
    account && inspected ? (
      <AccountChoices {...props} account={account} inspected={inspected} />
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
              size="md"
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
              placeholder="Search accounts"
              onChangeText={props.onSearch}
              autoFocus={!compact}
            />
          </View>
        </View>
        <Button
          variant="outline"
          size="md"
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

function AccountButton({
  group,
  active,
  selectedId,
  onInspect,
  renderRail,
}: {
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
  const usage = useMemo(
    () => (
      <View style={styles.usage}>
        {group.rows[0].localEndpoint ? null : renderRail(group.rows[0])}
      </View>
    ),
    [group, renderRail],
  );
  return (
    <ComboboxItem
      descriptionSlot={usage}
      descriptionPlacement="below"
      labelNumberOfLines={1}
      label={group.label}
      labelStyle={styles.accountTitle}
      active={active}
      selectionPlacement="leading"
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
  ...props
}: AccountPresetMenuProps & {
  account: AccountPresets;
  inspected: AgentProfilePickerRow;
}) {
  const DetailScrollView = props.compact ? BottomSheetScrollView : ScrollView;
  const entry = props.entries?.find((candidate) => candidate.provider === account.provider);
  const definition = props.definitions.find((profile) => profile.id === inspected.id);
  const { onApply } = props;
  const apply = useCallback(() => onApply(inspected.id), [onApply, inspected.id]);
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
          <Text style={styles.summary}>{inspected.summary}</Text>
          {inspected.localEndpoint ? props.renderRail(inspected) : null}
          {definition ? (
            <ProfileDetailsView serverId={props.serverId} profile={definition} compact />
          ) : null}
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
                {props.definitions.find((profile) => profile.id === definition.workerProfileId)
                  ?.name ?? definition.workerProfileId}{" "}
                · Up to {definition.maxWorkers ?? 2}
              </Text>
            </>
          ) : null}
        </View>
      </DetailScrollView>
      <View style={styles.footer}>
        <Button
          variant="default"
          size="md"
          disabled={props.disabled || inspected.unavailable}
          onPress={apply}
          testID="preset-use-profile"
        >
          Use profile
        </Button>
      </View>
    </View>
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
        label={intelligenceLabel(definition, entry)}
        description={row.name}
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
    padding: theme.spacing[3],
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
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  accountButton: {
    height: Math.max(80, Math.ceil(theme.fontSize.base * 1.4) * 3 + theme.spacing[4]),
    borderRadius: theme.borderRadius.md,
  },
  accountTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  usage: {
    height: Math.max(32, Math.ceil(theme.fontSize.base * 1.4) * 2),
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

import { useCallback, useMemo, useEffect, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import { getHostRuntimeStore, useHostRegistryLoaded } from "@/runtime/host-runtime";
import { useVortonMode } from "@/vorton-mode";
import { readExecutionInstallation } from "./policy";
import { InstallationClient, requestInstallationOwner, hasInstallationConnections } from "./client";
import { InstallationPanelModel } from "./panel-model";
import type { ProfileSharingStatus, RestartJob } from "@getpaseo/protocol/execution-installation";

let panelModel: InstallationPanelModel | null = null;
function getInstallationPanel(registryLoaded: boolean): InstallationPanelModel | null {
  const installation = readExecutionInstallation();
  if (!installation) return null;
  const runtime = getHostRuntimeStore();
  if (!registryLoaded) return null;
  if (!panelModel)
    panelModel = new InstallationPanelModel(
      new InstallationClient(installation, {
        request: requestInstallationOwner,
        register: runtime,
      }),
      { connectionsRegistered: hasInstallationConnections(installation, runtime.getHosts()) },
    );
  return panelModel;
}

export function InstallationControlsButton() {
  const vortonMode = useVortonMode();
  const registryLoaded = useHostRegistryLoaded();
  const model = getInstallationPanel(registryLoaded);
  const open = useCallback(() => model?.open(), [model]);
  if (!vortonMode || !model) return null;
  return (
    <Button variant="outline" size="md" testID="installation-controls-open" onPress={open}>
      Installation controls
    </Button>
  );
}

export function InstallationPanelHost() {
  const registryLoaded = useHostRegistryLoaded();
  const model = getInstallationPanel(registryLoaded);
  return model ? <InstallationPanel model={model} /> : null;
}

function InstallationPanel({ model }: { model: InstallationPanelModel }) {
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useEffect(() => {
    const timer = setInterval(() => {
      void model.refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [model]);

  const header = useMemo(
    () => ({
      title: state.unlocked ? "Installation controls" : "Connect this Vorteo installation",
    }),
    [state.unlocked],
  );
  const close = useCallback(() => model.close(), [model]);
  const setPassword = useCallback((value: string) => model.setPassword(value), [model]);
  const unlock = useCallback(() => {
    void model.unlock();
  }, [model]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={state.visible}
      onClose={close}
      testID="installation-panel"
    >
      <View style={styles.body}>
        {!state.unlocked ? (
          <>
            <Text style={styles.text}>
              Connect the dev container and the full-access host in this interface. Use the
              installation password saved during setup.
            </Text>
            <AdaptiveTextInput
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              initialValue=""
              onChangeText={setPassword}
              accessibilityLabel="Installation password"
              testID="installation-password"
              style={styles.input}
            />
            <Button
              disabled={state.busy || !state.password}
              onPress={unlock}
              testID="installation-unlock"
            >
              {state.busy ? "Connecting…" : "Connect environments"}
            </Button>
          </>
        ) : (
          <>
            <Text style={styles.text}>
              Dev-container agents cannot approve these requests or control the host. Approved
              restarts are monitored by the installation.
            </Text>
            <ProfileSharingStatusView
              status={state.profileSharing}
              model={model}
              busy={state.busy}
            />
            {state.jobs.length === 0 ? <Text style={styles.text}>No restart requests.</Text> : null}
            {state.jobs
              .slice(-20)
              .toReversed()
              .map((job) => (
                <RestartRequest key={job.id} job={job} model={model} busy={state.busy} />
              ))}
          </>
        )}
        {state.error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {state.error}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function ProfileSharingStatusView({
  status,
  model,
  busy,
}: {
  status: ProfileSharingStatus | null;
  model: InstallationPanelModel;
  busy: boolean;
}) {
  if (!status)
    return (
      <Text style={styles.text}>
        Profile sharing is waiting for every environment to connect with an updated daemon.
      </Text>
    );
  return (
    <View style={styles.body}>
      <Text style={styles.text}>
        Agent workflows, provider defaults, and model choices synchronize across environments.
        Credentials and provider availability stay local.
      </Text>
      {Object.entries(status.sources).map(([serverId, source]) => (
        <ProfileSharingEnvironment
          key={serverId}
          serverId={serverId}
          source={source}
          model={model}
          busy={busy}
        />
      ))}
    </View>
  );
}

function ProfileSharingEnvironment({
  serverId,
  source,
  model,
  busy,
}: {
  serverId: string;
  source: ProfileSharingStatus["sources"][string];
  model: InstallationPanelModel;
  busy: boolean;
}) {
  const installation = readExecutionInstallation();
  const label =
    installation?.environments.find((environment) => environment.serverId === serverId)?.kind ===
    "host"
      ? "Host"
      : "Dev container";
  const useShared = useCallback(() => {
    void model.resolveProfileConflict(serverId, "shared");
  }, [model, serverId]);
  const useEnvironment = useCallback(() => {
    void model.resolveProfileConflict(serverId, "environment");
  }, [model, serverId]);
  return (
    <View style={styles.body}>
      <Text style={styles.text}>
        {label}: {source.error ?? "Profiles synchronized"}
      </Text>
      {source.conflicts.length ? (
        <>
          <Text style={styles.text}>
            Conflicting fields: {source.conflicts.join(", ")}. Independent edits are preserved.
          </Text>
          {source.conflictValues.map((value) => (
            <Text key={value.field} style={styles.text}>
              {value.field}
              {"\n"}Shared: {value.sharedValue}
              {"\n"}
              {label}: {value.environmentValue}
            </Text>
          ))}
          <Button variant="outline" disabled={busy} onPress={useShared}>
            Use shared values
          </Button>
          <Button variant="outline" disabled={busy} onPress={useEnvironment}>
            Use {label} values
          </Button>
        </>
      ) : null}
    </View>
  );
}

function RestartRequest({
  job,
  model,
  busy,
}: {
  job: RestartJob;
  model: InstallationPanelModel;
  busy: boolean;
}) {
  const approve = useCallback(async () => {
    const target = job.target === "host" ? "native host daemon" : "dev-container daemon";
    const confirmed = await confirmDialog({
      title: `Restart ${target}?`,
      message: `Running agents and terminals on this daemon may be interrupted. This approves only this restart request.\n\nReason: ${job.reason}`,
      confirmLabel: "Approve restart",
      destructive: true,
    });
    if (confirmed) await model.decide(job, "approve");
  }, [job, model]);
  const reject = useCallback(() => {
    void model.decide(job, "reject");
  }, [job, model]);
  return (
    <View style={styles.request} testID={`restart-request-${job.id}`}>
      <Text style={styles.title}>
        {job.target === "host" ? "Host: full account access" : "Dev container"} · {job.status}
      </Text>
      <Text style={styles.text}>{job.reason}</Text>
      <Text style={styles.text}>
        {job.requestedBy} · {job.detail}
      </Text>
      {job.status === "pending" ? (
        <View style={styles.actions}>
          <Button
            variant="outline"
            disabled={busy}
            onPress={approve}
            testID={`restart-approve-${job.id}`}
          >
            Review restart
          </Button>
          <Button variant="ghost" disabled={busy} onPress={reject}>
            Reject
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[6], gap: theme.spacing[4] },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
  },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
  request: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderColor: theme.colors.border,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));

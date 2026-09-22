import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { refreshAndApplyProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { useVortonMode } from "@/vorton-mode";
import { ProviderLoginPanel } from "./login-panel";
import { openAccountForm, type CreatedCodexAccount } from "./account-form";

interface AddAccountProps {
  serverId: string;
  onCreated?: (account: CreatedCodexAccount) => void;
}
const header = { title: "Add Codex account" };

export function AddCodexAccountButton({
  catalog = false,
  style,
  ...props
}: AddAccountProps & { catalog?: boolean; style?: StyleProp<ViewStyle> }) {
  const vortonMode = useVortonMode();
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  if (!vortonMode) return null;
  return (
    <>
      <Button
        variant={catalog ? "default" : "outline"}
        size={catalog ? "sm" : "md"}
        style={style}
        onPress={show}
        testID="add-codex-account"
      >
        {catalog ? "Add" : "Add Codex account"}
      </Button>
      {open ? <AccountSheet key={props.serverId} {...props} onClose={close} /> : null}
    </>
  );
}

function AccountSheet({ onClose, ...props }: AddAccountProps & { onClose: () => void }) {
  const supported = useHostFeature(props.serverId, "codexAccountCreation");
  const permissions = useSessionStore(
    (state) => state.sessions[props.serverId]?.serverInfo?.permissions,
  );
  const canManage = permissions?.includes("daemon.manage") !== false;
  let message: string | null = null;
  if (!supported) message = "Update this host to add Codex accounts here.";
  else if (!canManage)
    message = "This connection needs permission to manage the host before it can add an account.";
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={onClose}
      desktopMaxWidth={520}
      testID="add-codex-account-dialog"
    >
      <View style={styles.body}>
        {message ? (
          <Text style={styles.text}>{message}</Text>
        ) : (
          <AccountForm {...props} onClose={onClose} />
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

function useAccountForm({ serverId, onCreated }: AddAccountProps) {
  const client = useHostRuntimeClient(serverId);
  const cache = useQueryClient();
  const live = useRef({ client, onCreated });
  live.current = { client, onCreated };
  const [model] = useState(() =>
    openAccountForm(globalThis.crypto.randomUUID(), {
      async create(creationId, name) {
        const current = live.current.client;
        if (!current) throw new Error("Reconnect to the host and try again.");
        const account = await current.createCodexAccount(creationId, name);
        await cache.invalidateQueries({ queryKey: daemonConfigQueryKey(serverId) });
        await refreshAndApplyProvidersSnapshot({
          client: current,
          queryClient: cache,
          serverId,
          cwd: null,
          providers: [account.providerId],
        });
        return account;
      },
      created(account) {
        live.current.onCreated?.(account);
      },
    }),
  );
  useEffect(() => () => model.close(), [model]);
  return { model, state: useSyncExternalStore(model.subscribe, model.getState, model.getState) };
}

function AccountForm({ onClose, ...props }: AddAccountProps & { onClose: () => void }) {
  const { model, state } = useAccountForm(props);
  const connected = useHostRuntimeIsConnected(props.serverId);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  if (state.phase === "created")
    return (
      <>
        <Text style={styles.text}>{state.account.name} added.</Text>
        <ProviderLoginPanel
          serverId={props.serverId}
          providerId={state.account.providerId}
          name={state.account.name}
        />
        <Button variant="outline" onPress={onClose} testID="codex-account-done">
          Done
        </Button>
      </>
    );
  const creating = state.phase === "creating";
  return (
    <>
      <Field label="Account name">
        <FormTextInput
          initialValue=""
          onChangeText={model.setName}
          editable={!creating}
          size={size}
          accessibilityLabel="Account name"
          testID="codex-account-name"
        />
      </Field>
      {state.error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {state.error}
        </Text>
      ) : null}
      {!connected ? (
        <Text style={styles.error}>Reconnect to the host to add this account.</Text>
      ) : null}
      <Button
        onPress={model.submit}
        disabled={creating || !connected}
        loading={creating}
        testID="codex-account-create"
      >
        Create account
      </Button>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4], gap: theme.spacing[4] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));

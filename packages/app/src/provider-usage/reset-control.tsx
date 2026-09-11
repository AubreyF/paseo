import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { useVortonMode } from "@/vorton-mode";
import { useFetchQuery } from "@/data/query";
import type { ProviderResetView } from "@getpaseo/protocol/provider-reset";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { providerUsageQueryKey } from "./use-provider-usage";
import { currentResetPreparation, resetCountLabel, resetPresentation } from "./reset-state";
import { providerResetQueryOptions } from "./reset-query";
import { prepareResetForView, reconcileResetResult, resetResultNotice } from "./reset-result";

function useResetControl({
  serverId,
  providerId,
  name,
  preloaded = false,
}: {
  serverId: string | null;
  providerId: string;
  name: string;
  preloaded?: boolean;
}) {
  const client = useHostRuntimeClient(serverId ?? "");
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const vortonMode = useVortonMode();
  const hostSupported = useSessionStore(
    (state) =>
      state.sessions[serverId ?? ""]?.serverInfo?.features?.providerResetManagement === true,
  );
  const cache = useQueryClient();
  const supported = vortonMode && hostSupported;
  const clientGeneration = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.clientGeneration,
  );
  const queryOptions = useMemo(
    () =>
      providerResetQueryOptions({
        serverId,
        providerId,
        clientGeneration,
        client,
        enabled: Boolean(client && connected && supported && !preloaded),
      }),
    [serverId, providerId, clientGeneration, client, connected, supported, preloaded],
  );
  const key = queryOptions.queryKey;
  const [open, setOpen] = useState(false);
  const [preparation, setPrepared] = useState<ProviderResetView | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const query = useFetchQuery(queryOptions);
  const prepared = currentResetPreparation(preparation, query.data);
  const view = prepared ?? query.data;
  const snapshot = view?.snapshot;
  const available = snapshot?.status === "available" ? snapshot : null;
  const header = useMemo(() => ({ title: `Reset credits: ${name}` }), [name]);
  const close = useCallback(() => {
    if (!busyRef.current) {
      setOpen(false);
      setPrepared(null);
      setNotice(null);
    }
  }, []);
  const refresh = useCallback(() => {
    if (busyRef.current) return;
    setPrepared(null);
    setNotice(null);
    void query.refetch();
  }, [query]);
  const act = useCallback(async () => {
    const viewed = query.data;
    if (busyRef.current || !client || !available || !connected || !viewed) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      if (!prepared?.operation) {
        const result = await prepareResetForView(
          viewed,
          () => cache.getQueryData<ProviderResetView>(key),
          () => client.prepareProviderReset(providerId, available.accountId),
        );
        setPrepared(result);
        if (!result) {
          setNotice(
            "Account details changed during review. Refresh and review the current account before confirming.",
          );
          return;
        }
        cache.setQueryData(key, result);
      } else {
        const result = await client.confirmProviderReset(
          providerId,
          available.accountId,
          prepared.operation.operationId,
        );
        // Keep the confirmed key available if reconciliation needs another attempt.
        if (!result.refreshError) setPrepared(null);
        setNotice(resetResultNotice(result));
        if (result.view && cache.getQueryData(key) === viewed) cache.setQueryData(key, result.view);
        setNotice(
          await reconcileResetResult(result, [
            () =>
              cache.invalidateQueries(
                { queryKey: ["providerReset", serverId] },
                { throwOnError: true },
              ),
            () =>
              cache.invalidateQueries(
                { queryKey: providerUsageQueryKey(serverId) },
                { throwOnError: true },
              ),
          ]),
        );
      }
    } catch {
      // Keep the prepared account/key after an uncertain confirmation. Retrying
      // is a second explicit action and never allocates a replacement key.
      setNotice(
        "The operation could not be verified. Refresh account details or explicitly retry this same confirmation. No task has resumed.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [available, cache, client, connected, key, prepared, providerId, serverId, query.data]);
  const press = useCallback(() => {
    void act();
  }, [act]);
  const show = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
    setOpen(true);
  }, []);
  return {
    query,
    view,
    available,
    header,
    close,
    refresh,
    press,
    show,
    supported,
    open,
    connected,
    busy,
    prepared,
    notice,
  };
}

function CreditDetails({
  available,
}: {
  available: Extract<ProviderResetView["snapshot"], { status: "available" }> | null;
}) {
  return (
    <>
      {available?.credits?.map((credit) => (
        <View key={credit.id} style={styles.credit}>
          <Text style={styles.text}>
            {credit.title ?? "Reset credit"} · {credit.status}
          </Text>
          {credit.description ? <Text style={styles.text}>{credit.description}</Text> : null}
          <Text style={styles.text}>
            Granted {new Date(credit.grantedAt * 1000).toLocaleString()}
          </Text>
          <Text style={styles.text}>
            {credit.expiresAt === null
              ? "Expiry not reported"
              : `Expires ${new Date(credit.expiresAt * 1000).toLocaleString()}`}
          </Text>
        </View>
      ))}
      {available && (!available.credits || available.credits.length < available.availableCount) ? (
        <Text style={styles.text}>
          The provider has not supplied details for every available credit.
        </Text>
      ) : null}
    </>
  );
}

export function ProviderResetControl(props: {
  critical?: boolean;
  compact?: boolean;
  preloaded?: boolean;
  serverId: string | null;
  providerId: string;
  name: string;
}) {
  const {
    query,
    view,
    available,
    header,
    close,
    refresh,
    press,
    show,
    supported,
    open,
    connected,
    busy,
    prepared,
    notice,
  } = useResetControl(props);
  const { name, providerId } = props;
  const criticalTextStyle = useMemo(
    () => (props.critical ? styles.critical : undefined),
    [props.critical],
  );
  const { visible, showBadge, badge, pending, enabled } = resetPresentation({
    supported,
    connected,
    open,
    current: query.data,
    displayed: view,
    readFailed: query.isError,
    positiveOnly: props.compact,
  });
  if (!visible) return null;
  return (
    <>
      {showBadge ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={show}
          accessibilityLabel={`${name}: ${badge}`}
          style={props.compact ? styles.compactBadge : undefined}
          textStyle={[styles.text, criticalTextStyle]}
          testID={`provider-reset-${providerId}`}
        >
          {props.compact ? (
            <Text numberOfLines={1} style={criticalTextStyle}>
              {badge}
            </Text>
          ) : (
            badge
          )}
        </Button>
      ) : null}
      {open ? (
        <AdaptiveModalSheet
          visible
          header={header}
          onClose={close}
          desktopMaxWidth={560}
          testID="provider-reset-dialog"
        >
          <View style={styles.body}>
            <Text style={styles.text}>
              {available?.accountLabel ?? "Account label unavailable"}
            </Text>
            {available ? <Text style={styles.text}>Account: {available.accountId}</Text> : null}
            <Text style={styles.text}>
              {available
                ? `${resetCountLabel(available.availableCount)} available`
                : "Reset availability is unknown."}
            </Text>
            <Text style={styles.text}>
              Uses an existing credit for this account. No purchase, account switch or automatic
              task restart.
            </Text>
            {pending ? (
              <Text style={styles.text}>
                An earlier attempt is unresolved. Confirmation will reuse its saved operation key.
              </Text>
            ) : null}
            <CreditDetails available={available} />
            {view ? (
              <Text style={styles.text}>Updated {new Date(view.fetchedAt).toLocaleString()}</Text>
            ) : null}
            {!view?.canRedeem ? (
              <Text style={styles.text}>
                This provider has not verified reset redemption support.
              </Text>
            ) : null}
            {prepared ? (
              <Text style={styles.text}>
                Confirm use of one reset credit for the account shown above. The provider decides
                eligibility.
              </Text>
            ) : null}
            {query.isError ? (
              <Text style={styles.text}>
                Could not refresh account details. Displayed data may be stale.
              </Text>
            ) : null}
            {notice ? (
              <Text style={styles.text} accessibilityRole="alert">
                {notice}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Button variant="ghost" onPress={close} disabled={busy}>
                Close
              </Button>
              <Button variant="ghost" onPress={refresh} disabled={busy || !connected}>
                Refresh
              </Button>
              <Button onPress={press} disabled={busy || !enabled} testID="provider-reset-action">
                {prepared ? "Confirm reset" : "Review reset"}
              </Button>
            </View>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  critical: { color: theme.colors.destructive },
  compactBadge: {
    position: "absolute",
    right: 0,
    top: (Math.ceil(theme.fontSize.base * 1.4) - 44) / 2,
    height: 44,
    minHeight: 44,
    paddingHorizontal: 0,
    maxWidth: "100%",
  },
  body: { padding: theme.spacing[4], gap: theme.spacing[3] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  credit: { gap: theme.spacing[1], paddingVertical: theme.spacing[2] },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));

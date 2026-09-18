import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { QueueItem } from "@getpaseo/protocol/message-queue";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { useMessageQueue, type MessageQueueControl } from "./use-message-queue";
import { canKeepRejectedChange, type OutboxRecord } from "./outbox-record";

export function SharedQueueView({ serverId, agentId }: { serverId: string; agentId: string }) {
  const control = useMessageQueue(serverId, agentId);
  const snapshot = control.snapshot;
  const toggle = useCallback(() => {
    if (snapshot)
      void control
        .mutate({ kind: "pause", paused: !snapshot.paused, expectedRevision: snapshot.revision })
        .catch(() => {});
  }, [control, snapshot]);
  if (!control.visible) return null;
  if (!control.supported && !control.pending.length) return null;
  if (
    !snapshot?.items.length &&
    !snapshot?.paused &&
    !control.pending.length &&
    !control.error &&
    !control.loading
  )
    return null;
  return (
    <View style={styles.container} testID="shared-message-queue">
      <View style={styles.row}>
        <Text style={styles.heading}>{snapshot?.paused ? "Queue paused" : "Shared queue"}</Text>
        {!control.connected ? <Text style={styles.secondary}>Offline</Text> : null}
        {snapshot ? (
          <Button
            size="sm"
            variant="ghost"
            style={styles.touch}
            disabled={!control.canMutate}
            onPress={toggle}
          >
            {snapshot.paused ? "Resume" : "Pause"}
          </Button>
        ) : null}
      </View>
      {control.loading ? <Text style={styles.secondary}>Loading queue...</Text> : null}
      {control.error ? (
        <View style={styles.row}>
          <Text style={styles.error} accessibilityRole="alert">
            {control.error}
          </Text>
          <Button size="sm" style={styles.touch} onPress={control.refresh}>
            Retry
          </Button>
        </View>
      ) : null}
      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {snapshot?.items.map((item, index) => (
          <QueueRow key={item.id} item={item} index={index} control={control} />
        ))}
        {control.pending.map((record) => (
          <PendingRow key={record.operation.operationId} record={record} control={control} />
        ))}
      </ScrollView>
    </View>
  );
}

function PendingRow({ record, control }: { record: OutboxRecord; control: MessageQueueControl }) {
  const [error, setError] = useState<string | null>(null);
  const keepCopy = useCallback(() => {
    setError(null);
    void control
      .keepLocalCopy(record)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Could not keep the local copy."),
      );
  }, [control, record]);
  const removeCopy = useCallback(() => {
    setError(null);
    void control
      .removeLocalCopy(record)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Could not remove the local copy."),
      );
  }, [control, record]);
  const retry = useCallback(() => {
    setError(null);
    void control
      .retry(record)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Retry failed."),
      );
  }, [record, control]);
  return (
    <View style={styles.item}>
      <Text style={styles.secondary}>
        {record.error ? "Could not synchronize" : "Saved on this device"}
      </Text>
      {record.dismissed ? (
        <Text style={styles.secondary}>Kept locally. This change will not be sent.</Text>
      ) : null}
      <Text selectable style={styles.text}>
        {"text" in record.operation ? record.operation.text : record.operation.kind}
      </Text>
      {record.error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {record.error.message}
        </Text>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      {record.error && !record.dismissed ? (
        <Button size="sm" style={styles.touch} disabled={!control.connected} onPress={retry}>
          Retry synchronization
        </Button>
      ) : null}
      {canKeepRejectedChange(record) ? (
        <Button size="sm" style={styles.touch} onPress={keepCopy}>
          Keep local copy and continue queue
        </Button>
      ) : null}
      {record.dismissed ? (
        <Button size="sm" style={styles.touch} onPress={removeCopy}>
          Remove local copy
        </Button>
      ) : null}
    </View>
  );
}

function QueueRow({
  item,
  index,
  control,
}: {
  item: QueueItem;
  index: number;
  control: MessageQueueControl;
}) {
  const [editing, setEditing] = useState<QueueItem | null>(null);
  const edit = useCallback(() => setEditing(item), [item]);
  const close = useCallback(() => setEditing(null), []);
  return (
    <View style={styles.item} testID={`queue-message-${item.id}`}>
      <Text style={styles.text} selectable>
        {item.text}
      </Text>
      {item.attachments.map((attachment) => (
        <Text key={attachment.id} style={styles.secondary}>
          {attachment.fileName}
        </Text>
      ))}
      {item.context?.length ? (
        <Text style={styles.secondary}>{item.context.length} context attachment(s)</Text>
      ) : null}
      {item.delivery.status === "dispatching" ? (
        <Text style={styles.secondary}>Sending...</Text>
      ) : null}
      {"reason" in item.delivery ? (
        <Text style={styles.error} accessibilityRole="alert">
          {item.delivery.reason}
        </Text>
      ) : null}
      {item.delivery.status === "uncertain" ? (
        <Text style={styles.secondary}>
          The host could not confirm delivery. Retrying may send this message again.
        </Text>
      ) : null}
      <QueueActions item={item} index={index} control={control} edit={edit} />
      {editing ? (
        <QueueEdit
          key={`${editing.id}:${editing.revision}`}
          item={editing}
          control={control}
          close={close}
        />
      ) : null}
    </View>
  );
}

function QueueActions({
  item,
  index,
  control,
  edit,
}: {
  item: QueueItem;
  index: number;
  control: MessageQueueControl;
  edit: () => void;
}) {
  const queued = item.delivery.status === "queued";
  const sendNow = useCallback(() => {
    void control
      .mutate({
        kind: "send_now",
        messageId: item.id,
        expectedRevision: item.revision,
        expectedTurnId: control.activeTurnId,
      })
      .catch(() => {});
  }, [control, item]);
  const blocked = item.delivery.status === "uncertain" || item.delivery.status === "failed";
  const reorderable =
    control.snapshot?.items.every((entry) => entry.delivery.status === "queued") ?? false;
  const remove = useCallback(() => {
    void control
      .mutate({ kind: "delete", messageId: item.id, expectedRevision: item.revision })
      .catch(() => {});
  }, [control, item]);
  const retry = useCallback(() => {
    void control
      .mutate({
        kind: "resolve",
        action: "retry",
        messageId: item.id,
        expectedRevision: item.revision,
      })
      .catch(() => {});
  }, [control, item]);
  const discard = useCallback(() => {
    void control
      .mutate({
        kind: "resolve",
        action: "discard",
        messageId: item.id,
        expectedRevision: item.revision,
      })
      .catch(() => {});
  }, [control, item]);
  const move = useCallback(
    (offset: number) => {
      const snapshot = control.snapshot;
      if (!snapshot) return;
      const ids = snapshot.items.map((entry) => entry.id);
      [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
      void control
        .mutate({ kind: "reorder", expectedRevision: snapshot.revision, messageIds: ids })
        .catch(() => {});
    },
    [control, index],
  );
  const moveUp = useCallback(() => move(-1), [move]);
  const moveDown = useCallback(() => move(1), [move]);
  return (
    <View style={styles.row}>
      {queued ? (
        <Button
          size="sm"
          style={styles.touch}
          disabled={!control.canMutate || !!item.sendNow}
          onPress={sendNow}
        >
          Send now
        </Button>
      ) : null}
      {queued ? (
        <Button size="sm" style={styles.touch} disabled={!control.canMutate} onPress={edit}>
          Edit
        </Button>
      ) : null}
      {queued ? (
        <Button size="sm" style={styles.touch} disabled={!control.canMutate} onPress={remove}>
          Remove
        </Button>
      ) : null}
      {queued && index > 0 ? (
        <Button
          size="sm"
          style={styles.touch}
          disabled={!control.canMutate || !reorderable}
          onPress={moveUp}
        >
          Move up
        </Button>
      ) : null}
      {queued && index < (control.snapshot?.items.length ?? 0) - 1 ? (
        <Button
          size="sm"
          style={styles.touch}
          disabled={!control.canMutate || !reorderable}
          onPress={moveDown}
        >
          Move down
        </Button>
      ) : null}
      {blocked ? (
        <>
          <Button size="sm" style={styles.touch} disabled={!control.canMutate} onPress={retry}>
            Retry delivery
          </Button>
          <Button size="sm" style={styles.touch} disabled={!control.canMutate} onPress={discard}>
            Discard
          </Button>
        </>
      ) : null}
    </View>
  );
}

function QueueEdit({
  item,
  control,
  close,
}: {
  item: QueueItem;
  control: MessageQueueControl;
  close: () => void;
}) {
  const [text, setText] = useState(item.text);
  const save = useCallback(() => {
    void control
      .mutate({
        kind: "edit",
        messageId: item.id,
        expectedRevision: item.revision,
        text,
        attachments: item.attachments,
        context: item.context,
      })
      .then(close)
      .catch(() => {});
  }, [item, control, close, text]);
  return (
    <View style={styles.item}>
      <EditingTextInput
        initialValue={item.text}
        onChangeText={setText}
        multiline
        style={styles.input}
        accessibilityLabel="Edit queued message"
      />
      <View style={styles.row}>
        <Button size="sm" style={styles.touch} disabled={!control.canMutate} onPress={save}>
          Save
        </Button>
        <Button size="sm" style={styles.touch} onPress={close}>
          Cancel
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[1] },
  heading: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm, flexShrink: 1 },
  touch: { minHeight: 44, minWidth: 44 },
  item: { gap: theme.spacing[1], paddingVertical: theme.spacing[2] },
  list: { maxHeight: 280 },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    minHeight: 80,
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
}));

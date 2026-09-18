interface ConnectionToastInput {
  vortonMode: boolean;
  content: unknown;
  testID?: string;
}

// Match client transport errors only. Permission, provider, and operation failures
// must retain their own error presentation.
export function isConnectionToast({ vortonMode, content, testID }: ConnectionToastInput): boolean {
  if (!vortonMode) return false;
  if (testID === "agent-reconnecting-toast") return true;
  if (typeof content !== "string") return false;
  return /^Transport (?:closed(?: \(code \d+\))?|not connected(?: \(status: [a-z]+\))?)$/.test(
    content.trim(),
  );
}

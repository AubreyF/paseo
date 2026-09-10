export function isQuotaExhaustionMessage(message: string): boolean {
  return message.startsWith("[System Error]") && /\bcode: quota_exhausted\b/.test(message);
}

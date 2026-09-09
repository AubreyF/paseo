export class ProviderQuotaExhaustedError extends Error {
  readonly code = "quota_exhausted";
  constructor(message: string) {
    super(message);
    this.name = "ProviderQuotaExhaustedError";
  }
}

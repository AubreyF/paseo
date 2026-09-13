export interface ProviderLoginChallenge {
  verificationUrl: string;
  userCode: string;
}

/** A dedicated provider process owns sign-in, never an agent's active transport. */
export interface ProviderLoginSession {
  readonly scope: string;
  start(onComplete: (success: boolean) => void): Promise<ProviderLoginChallenge>;
  readAccountLabel(): Promise<string | null>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ProviderLoginChallenge {
  verificationUrl: string;
  userCode: string;
  inputRequired?: boolean;
}

/** A dedicated provider process owns sign-in, never an agent's active transport. */
export interface ProviderLoginSession {
  readonly scope: string;
  start(onComplete: (success: boolean) => void): Promise<ProviderLoginChallenge>;
  submitCode?(code: string): Promise<void>;
  readAccountLabel(): Promise<string | null>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

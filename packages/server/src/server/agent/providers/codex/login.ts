import { z } from "zod";
import type { ProviderLoginSession } from "../../../../services/provider-login/session.js";
import type { CodexAppServerClient } from "./app-server-transport.js";

const ChallengeSchema = z.object({
  type: z.literal("chatgptDeviceCode"),
  loginId: z.string().min(1),
  verificationUrl: z.string().url(),
  userCode: z.string().min(1),
});
const CompletionSchema = z.object({ loginId: z.string(), success: z.boolean() });
const AccountSchema = z.object({
  account: z.object({ type: z.literal("chatgpt"), email: z.string().nullish() }),
});
type Completion = z.infer<typeof CompletionSchema>;

export class CodexLoginSession implements ProviderLoginSession {
  private loginId: string | null = null;
  constructor(
    private readonly transport: Pick<
      CodexAppServerClient,
      "request" | "setNotificationHandler" | "setUnexpectedTerminationHandler" | "dispose"
    >,
    readonly scope: string,
  ) {}

  async start(onComplete: (success: boolean) => void) {
    let earlyCompletion: Completion | null = null;
    this.transport.setUnexpectedTerminationHandler(() => onComplete(false));
    this.transport.setNotificationHandler((method, params) => {
      if (method !== "account/login/completed") return;
      const completion = CompletionSchema.safeParse(params);
      if (!completion.success) return;
      if (this.loginId === null) earlyCompletion = completion.data;
      else if (completion.data.loginId === this.loginId) onComplete(completion.data.success);
    });
    const challenge = ChallengeSchema.parse(
      await this.transport.request("account/login/start", { type: "chatgptDeviceCode" }, 30_000),
    );
    this.loginId = challenge.loginId;
    const url = new URL(challenge.verificationUrl);
    if (
      url.origin !== "https://auth.openai.com" ||
      url.pathname !== "/codex/device" ||
      url.username ||
      url.password
    ) {
      throw new Error("Unexpected device sign-in destination");
    }
    // A completion may precede the correlated start response on the transport.
    const completed = CompletionSchema.safeParse(earlyCompletion);
    if (completed.success && completed.data.loginId === this.loginId)
      onComplete(completed.data.success);
    return { verificationUrl: challenge.verificationUrl, userCode: challenge.userCode };
  }

  async readAccountLabel(): Promise<string | null> {
    const result = AccountSchema.parse(
      await this.transport.request("account/read", { refreshToken: false }, 15_000),
    );
    return result.account.email ?? null;
  }

  async cancel(): Promise<void> {
    if (this.loginId)
      await this.transport.request("account/login/cancel", { loginId: this.loginId }, 10_000);
  }

  dispose(): Promise<void> {
    return this.transport.dispose();
  }
}

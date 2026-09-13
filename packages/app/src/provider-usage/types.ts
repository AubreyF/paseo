import type {
  ProviderUsage as WireProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageListResponseMessage,
  ProviderUsageStatus,
  ProviderUsageTone,
  ProviderUsageWindow,
} from "@getpaseo/protocol/messages";

export type {
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageStatus,
  ProviderUsageTone,
  ProviderUsageWindow,
};

export type ProviderUsageBalanceUnit = ProviderUsageBalance["unit"];
export type ProviderUsage = WireProviderUsage & { refreshError?: string };
export type ProviderUsageListPayload = Omit<
  ProviderUsageListResponseMessage["payload"],
  "providers"
> & { providers: ProviderUsage[] };

export type ProviderUsageView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      payload: ProviderUsageListPayload;
      isRefreshing: boolean;
      refreshError?: string;
    };

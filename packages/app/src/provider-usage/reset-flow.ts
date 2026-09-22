import type { ProviderResetResult, ProviderResetView } from "@getpaseo/protocol/provider-reset";

export interface ResetFlow {
  stage: "browse" | "review" | "result";
  selection: { accountId: string; creditId: string } | null;
  preparation: ProviderResetView | null;
  busy: boolean;
  notice: string | null;
  uncertain: boolean;
  result: ProviderResetResult | null;
}

export const initialResetFlow: ResetFlow = {
  stage: "browse",
  selection: null,
  preparation: null,
  busy: false,
  notice: null,
  uncertain: false,
  result: null,
};

type ResetFlowAction =
  | { type: "clear" }
  | { type: "back" }
  | { type: "select"; accountId: string; creditId: string }
  | { type: "start" }
  | { type: "prepared"; view: ProviderResetView }
  | { type: "result"; result: ProviderResetResult; notice: string }
  | { type: "failure"; notice: string; uncertain: boolean }
  | { type: "settled" };

export function resetFlowReducer(state: ResetFlow, action: ResetFlowAction): ResetFlow {
  switch (action.type) {
    case "clear":
      return initialResetFlow;
    case "back":
      return { ...initialResetFlow, selection: state.selection };
    case "select":
      return {
        ...initialResetFlow,
        selection: { accountId: action.accountId, creditId: action.creditId },
      };
    case "start":
      return { ...state, busy: true, notice: null };
    case "prepared":
      return {
        ...state,
        stage: "review",
        preparation: action.view,
        uncertain: action.view.operation?.state === "pending",
      };
    case "result":
      return {
        ...state,
        stage: "result",
        result: action.result,
        notice: action.notice,
        uncertain: false,
      };
    case "failure":
      return { ...state, notice: action.notice, uncertain: action.uncertain };
    case "settled":
      return { ...state, busy: false };
  }
}

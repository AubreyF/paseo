import Constants from "expo-constants";
import { useFetchQuery } from "@/data/query";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useVortonMode } from "@/vorton-mode";
import { checkVortonUpdate } from "./check";

const sourceCommit: unknown = Constants.expoConfig?.extra?.vortonBuildCommit;
export const VORTON_BUILD_COMMIT =
  typeof sourceCommit === "string" && /^[a-f0-9]{40}$/.test(sourceCommit) ? sourceCommit : null;
const CHECK_INTERVAL = 30 * 60 * 1000;

export function useVortonUpdate(poll = false) {
  const vorton = useVortonMode();
  const { isLoading: preferencesLoading } = useFormPreferences();
  return useFetchQuery({
    dataShape: "value",
    queryKey: ["vorton-update", VORTON_BUILD_COMMIT],
    queryFn: ({ signal }) => {
      if (!VORTON_BUILD_COMMIT) throw new Error("This build has no source commit.");
      return checkVortonUpdate(VORTON_BUILD_COMMIT, signal);
    },
    enabled: !preferencesLoading && vorton && VORTON_BUILD_COMMIT !== null,
    staleTimeMs: CHECK_INTERVAL,
    refetchInterval: poll ? CHECK_INTERVAL : false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
  });
}

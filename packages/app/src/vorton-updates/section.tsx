import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { useDraftStore } from "@/stores/draft-store";
import { buildNewWorkspaceDraftKey, generateDraftId } from "@/stores/draft-keys";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { openExternalUrl } from "@/utils/open-external-url";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useVortonMode } from "@/vorton-mode";
import { buildUpdatePrompt, VORTON_REPOSITORY, type VortonUpdate } from "./check";
import { useVortonUpdate, VORTON_BUILD_COMMIT } from "./use-update";
import { UpdateSuccessBadge } from "./success-badge";

function statusText(update: VortonUpdate | undefined, t: TFunction): string {
  if (!update) return t("settings.about.vortonUpdates.idle");
  return t(`settings.about.vortonUpdates.${update.status}`, { count: update.incomingCommits });
}

export function VortonUpdatesSection() {
  const vorton = useVortonMode();
  const { isLoading: preferencesLoading } = useFormPreferences();
  const { t } = useTranslation();
  const update = useVortonUpdate();
  const router = useRouter();
  const checking = update.isFetching || update.feedback.phase === "checking";
  const help = useCallback(() => {
    const draftId = generateDraftId();
    useDraftStore.getState().saveDraftInput({
      draftKey: buildNewWorkspaceDraftKey(draftId),
      draft: {
        text: buildUpdatePrompt(VORTON_BUILD_COMMIT, update.data?.latestCommit ?? null),
        attachments: [],
      },
    });
    router.push(buildNewWorkspaceRoute({ draftId }));
  }, [router, update.data?.latestCommit]);
  const changes = useCallback(() => {
    const url =
      VORTON_BUILD_COMMIT && update.data && update.data.status !== "unpublished"
        ? `${VORTON_REPOSITORY}/compare/${VORTON_BUILD_COMMIT}...${update.data.latestCommit}`
        : `${VORTON_REPOSITORY}/commits/main`;
    void openExternalUrl(url);
  }, [update.data]);
  if (!vorton || preferencesLoading) return null;
  let message = statusText(update.data, t);
  if (!VORTON_BUILD_COMMIT) message = t("settings.about.vortonUpdates.unknown");
  else if (checking) message = t("settings.about.vortonUpdates.checking");
  else if (update.isError)
    message = t("settings.about.vortonUpdates.failed", { error: update.error.message });
  return (
    <SettingsSection
      title={t("settings.about.vortonUpdates.title")}
      testID="vorton-updates-section"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle} testID="vorton-update-status">
              {message}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {VORTON_BUILD_COMMIT
                ? t("settings.about.vortonUpdates.commit", {
                    commit: VORTON_BUILD_COMMIT.slice(0, 7),
                  }) + " "
                : ""}
              {t("settings.about.vortonUpdates.interval")}
            </Text>
          </View>
        </View>
        <View style={styles.actions}>
          <Button
            variant="outline"
            size="md"
            onPress={update.checkNow}
            loading={checking}
            disabled={!VORTON_BUILD_COMMIT}
            testID="vorton-check-update"
          >
            {t(`settings.about.vortonUpdates.${checking ? "checking" : "check"}`)}
          </Button>
          {update.feedback.phase === "success" && !update.isFetching && (
            <UpdateSuccessBadge
              label={t(
                `settings.about.vortonUpdates.${update.feedback.result?.status === "current" ? "confirmedCurrent" : "checkComplete"}`,
              )}
            />
          )}
          <Button variant="outline" size="md" onPress={changes}>
            {t("settings.about.vortonUpdates.changes")}
          </Button>
          <Button size="md" onPress={help} testID="vorton-help-update">
            {t("settings.about.vortonUpdates.help")}
          </Button>
        </View>
        <Text style={styles.hint}>{t("settings.about.vortonUpdates.instructions")}</Text>
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
}));

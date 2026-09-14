import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Command } from "commander";
import type { QuotaObservation } from "@getpaseo/protocol/quota-governor";
import type { ListResult, OutputSchema } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";
import { toScheduleCommandError, type ScheduleCommandOptions } from "./shared.js";

interface QuotaRow {
  key: string;
  value: string;
}
type QuotaClient = Pick<DaemonClient, "readProviderQuotaObservation" | "close">;

export async function runQuotaCommand(
  options: ScheduleCommandOptions & { provider?: string },
  _command: Command,
): Promise<ListResult<QuotaRow>> {
  if (!options.provider?.trim()) throw new Error("Choose a configured provider account.");
  const client = await connectToDaemon({ host: options.host });
  return inspectScheduleQuota({ client, providerId: options.provider });
}

export async function inspectScheduleQuota(input: {
  client: QuotaClient;
  providerId: string;
}): Promise<ListResult<QuotaRow>> {
  try {
    const result = await input.client.readProviderQuotaObservation(input.providerId);
    const schema: OutputSchema<QuotaRow> = {
      idField: "key",
      columns: [
        { header: "QUOTA", field: "key", width: 28 },
        { header: "OBSERVATION", field: "value", width: 70 },
      ],
      serialize: () => result,
    };
    return { type: "list", data: quotaRows(result.providerId, result.observation), schema };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_QUOTA_FAILED", "inspect schedule account quota", error);
  } finally {
    await input.client.close().catch(() => {});
  }
}

function quotaRows(providerId: string, observation: QuotaObservation): QuotaRow[] {
  const rows: QuotaRow[] = [{ key: "Account selection", value: providerId }];
  if (observation.status === "unavailable") {
    rows.push(
      { key: "Quota", value: "Unavailable" },
      { key: "Reason", value: observation.reason.replaceAll("_", " ") },
    );
    return rows;
  }
  rows.push(
    { key: "Authenticated account", value: `...${observation.account.accountId.slice(-8)}` },
    { key: "Observed at", value: observation.observedAt },
  );
  for (const window of observation.windows) {
    rows.push({
      key: `${window.bucketId} / ${window.windowId}`,
      value: `${(100 - window.usedPercent).toLocaleString()}% remaining (${window.durationMinutes.toLocaleString()} min)`,
    });
  }
  rows.push({
    key: "Consumption meters",
    value: observation.consumptionMeters.length.toLocaleString(),
  });
  for (const meter of observation.consumptionMeters) {
    rows.push({ key: meter.meterId, value: `${meter.unit}; ${meter.quality}` });
  }
  return rows;
}

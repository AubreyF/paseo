import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  QuotaAccountSchema,
  QuotaConsumptionLimitSchema,
  parseQuotaGovernorPolicy,
  type QuotaGovernorPolicy,
} from "@getpaseo/protocol/quota-governor";

const AccountingSemanticsSchema = QuotaConsumptionLimitSchema.omit({
  throttleAt: true,
  holdAt: true,
  freezeAt: true,
});
export const AccountingContractSchema = z
  .object({
    version: z.literal(1),
    account: QuotaAccountSchema,
    revision: z.string().min(1),
    semantics: z.array(AccountingSemanticsSchema),
  })
  .strict();
export type AccountingContract = z.infer<typeof AccountingContractSchema>;

function semantics(policy: QuotaGovernorPolicy): AccountingContract["semantics"] {
  return parseQuotaGovernorPolicy(policy)
    .consumptionLimits.map((limit) => ({
      meterId: limit.meterId,
      bucketId: limit.bucketId,
      revision: limit.revision,
      unit: limit.unit,
      period:
        limit.period.kind === "calendar_day"
          ? {
              kind: "calendar_day" as const,
              timezone: new Intl.DateTimeFormat("en", {
                timeZone: limit.period.timezone,
              }).resolvedOptions().timeZone,
            }
          : limit.period,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Only trusted configuration establishes new semantics; reservations cannot do so. */
export function createAccountingContract(policy: QuotaGovernorPolicy): AccountingContract {
  return {
    version: 1,
    account: policy.account,
    revision: randomUUID(),
    semantics: semantics(policy),
  };
}

/** Existing journals retain the contract captured before this schema existed. */
export function legacyAccountingContract(policy: QuotaGovernorPolicy): AccountingContract {
  const contract = createAccountingContract(policy);
  const revision = createHash("sha256")
    .update(JSON.stringify([contract.account, contract.semantics]))
    .digest("hex");
  return { ...contract, revision: `legacy:${revision}` };
}

export function satisfiesAccountingContract(
  contract: AccountingContract,
  policy: QuotaGovernorPolicy,
): boolean {
  if (
    contract.account.issuer !== policy.account.issuer ||
    contract.account.accountId !== policy.account.accountId
  )
    return false;
  const requested = new Set(semantics(policy).map((value) => JSON.stringify(value)));
  // Extra schedule restrictions may add obligations, never remove the account's.
  return contract.semantics.every((value) => requested.has(JSON.stringify(value)));
}

import * as v from "valibot";
import { resultRows, withTransaction } from "#db/client.ts";
import { settingsVersionIncrement } from "#db/settings/cache.ts";
import { settingUpsert, syncStoredSetting } from "#db/settings/raw-writes.ts";
import { setSnapshotField } from "#db/settings/snapshot.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { sameTaxPolicy } from "#shared/tax/transitions.ts";
import { NO_TAX, type TaxPolicy, TaxPolicySchema } from "#shared/tax/types.ts";

/** Missing legacy settings mean No tax. Corrupt stored policies must not hide. */
export const parseTaxPolicy = (stored: string): TaxPolicy =>
  stored === "" ? NO_TAX : v.parse(TaxPolicySchema, JSON.parse(stored));

/** Keep the stored object independent of callers' property order. */
export const serializeTaxPolicy = (policy: TaxPolicy): string => {
  const valid = v.parse(TaxPolicySchema, policy);
  return JSON.stringify(
    valid.mode === "none"
      ? NO_TAX
      : {
          mode: valid.mode,
          rateBasisPoints: valid.rateBasisPoints,
        },
  );
};

export const updateTaxPolicy = async (
  policy: TaxPolicy,
  expectedPolicy?: TaxPolicy,
): Promise<boolean> => {
  const stored = serializeTaxPolicy(policy);
  if (expectedPolicy !== undefined) v.parse(TaxPolicySchema, expectedPolicy);
  const committed = await withTransaction(
    async (tx) => {
      const result = await tx.execute({
        args: [CONFIG_KEYS.TAX],
        sql: "SELECT value FROM settings WHERE key = ?",
      });
      const [row] = resultRows<{ value: string }>(result);
      const current = parseTaxPolicy(row?.value ?? "");
      if (
        expectedPolicy !== undefined &&
        !sameTaxPolicy(current, expectedPolicy)
      )
        return false;
      await tx.batch([
        settingUpsert(CONFIG_KEYS.TAX, stored),
        settingsVersionIncrement(),
      ]);
      return true;
    },
    { invalidateCaches: false },
  );
  if (!committed) return false;
  syncStoredSetting(CONFIG_KEYS.TAX, (values) =>
    values.set(CONFIG_KEYS.TAX, stored),
  );
  setSnapshotField(CONFIG_KEYS.TAX, stored);
  return true;
};

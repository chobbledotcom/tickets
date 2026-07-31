import type { Client } from "@libsql/client";
import {
  LEGACY_PAYMENT_TABLE_NAMES,
  type LegacyPaymentTableName,
  legacyPaymentTableStatements,
} from "#shared/db/migrations/legacy-payment-schema.ts";

/**
 * Build the payment tables the site used before the payment aggregate, so a
 * test can start from an old database and migrate forward. The site itself
 * only ever retires these tables, never creates them, so this lives here.
 */
export const createLegacyPaymentTables = async (
  getDb: () => Client,
  names: readonly LegacyPaymentTableName[] = LEGACY_PAYMENT_TABLE_NAMES,
): Promise<void> => {
  await getDb().batch(names.flatMap(legacyPaymentTableStatements), "write");
};

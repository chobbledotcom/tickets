/**
 * processed_sms_inbound table operations.
 *
 * Short-lived idempotency ledger for inbound SMS webhook ids. The stable
 * gateway id is stored without message content or sender details so replayed
 * `sms:received` events cannot create duplicate activity-log entries.
 */

import { executeBatch, getDb, insert } from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";

/** Claim an inbound webhook id. Returns false when it was already processed. */
export const claimProcessedSmsInbound = async (
  webhookId: string,
): Promise<boolean> => {
  if (webhookId === "") return true;
  const stmt = insert("processed_sms_inbound", {
    created: nowIso(),
    webhook_id: webhookId,
  });
  const result = await getDb().execute({
    args: stmt.args,
    sql: stmt.sql.replace("INSERT INTO", "INSERT OR IGNORE INTO"),
  });
  return result.rowsAffected > 0;
};

/** Prune rows older than the given ISO cutoff. */
export const pruneProcessedSmsInboundBefore = (
  cutoffIso: string,
): Promise<void> =>
  executeBatch([
    {
      args: [cutoffIso],
      sql: "DELETE FROM processed_sms_inbound WHERE created < ?",
    },
  ]);

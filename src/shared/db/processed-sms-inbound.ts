/**
 * processed_sms_inbound table operations.
 *
 * Short-lived idempotency ledger for inbound SMS webhook ids. The stable
 * gateway id is stored without message content or sender details so replayed
 * `sms:received` events cannot create duplicate activity-log entries.
 */

import { executeBatch, executeChangedRow, insertOrIgnore } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { nowIso } from "#shared/now.ts";

/** Claim an inbound webhook id. Returns false when it was already processed. */
export const claimProcessedSmsInbound = async (
  webhookId: string,
): Promise<boolean> => {
  if (webhookId === "") return true;
  const stmt = insertOrIgnore("processed_sms_inbound", {
    created: nowIso(),
    webhook_id: webhookId,
  });
  return executeChangedRow(stmt);
};

/** Prune rows older than the given ISO cutoff. */
export const pruneProcessedSmsInboundBefore = (
  cutoffIso: string,
): Promise<void> =>
  executeBatch([
    sql`DELETE FROM processed_sms_inbound WHERE created < ${cutoffIso}`,
  ]);

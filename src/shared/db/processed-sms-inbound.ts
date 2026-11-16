/**
 * processed_sms_inbound table operations.
 *
 * Short-lived idempotency ledger for inbound SMS webhook ids. The stable
 * gateway id is stored without message content or sender details so replayed
 * `sms:received` events cannot create duplicate activity-log entries.
 */

import { executeBatch } from "#db/client.ts";
import { executeChangedRow } from "#db/guarded-writes.ts";
import { lessThan } from "#db/select/expression.ts";
import { tables } from "#db/select/tables.ts";
import { deleteFrom, insertInto } from "#db/write.ts";
import { nowIso } from "#shared/now.ts";

/** Claim an inbound webhook id. Returns false when it was already processed. */
export const claimProcessedSmsInbound = async (
  webhookId: string,
): Promise<boolean> => {
  if (webhookId === "") return true;
  const stmt = insertInto(
    tables.processed_sms_inbound,
    { created: nowIso(), webhook_id: webhookId },
    { or: "IGNORE" },
  );
  return executeChangedRow(stmt);
};

/** Prune rows older than the given ISO cutoff. */
export const pruneProcessedSmsInboundBefore = (
  cutoffIso: string,
): Promise<void> =>
  executeBatch([
    deleteFrom(tables.processed_sms_inbound).where((row) =>
      lessThan(row.created, cutoffIso),
    ),
  ]);

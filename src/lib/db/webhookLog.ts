/**
 * Webhook error log
 *
 * Stores minimal log entries when outgoing webhook calls receive non-2xx responses.
 * Not encrypted — only stores the HTTP status code and public event name(s).
 */

import { getDb } from "#lib/db/client.ts";
import { nowIso } from "#lib/now.ts";

/** Webhook log row */
export interface WebhookLogEntry {
  id: number;
  created: string;
  status_code: number;
  event_name: string;
}

/**
 * Log a webhook error (non-2xx response)
 */
export const logWebhookError = async (
  statusCode: number,
  eventName: string,
): Promise<void> => {
  await getDb().execute({
    sql: "INSERT INTO webhook_log (created, status_code, event_name) VALUES (?, ?, ?)",
    args: [nowIso(), statusCode, eventName],
  });
};

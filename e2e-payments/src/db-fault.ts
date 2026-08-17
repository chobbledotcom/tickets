/**
 * A scoped Money-write failure for the live Stripe fault scenario.
 *
 * The ordinary deterministic helper writes through the test process's singleton
 * database connection; here the app runs in its own child process against its
 * own fresh file database, so the fault must be installed through a separate
 * libsql connection to that exact database. The trigger is persistent (a
 * temporary trigger would be connection-local and never reach the app server's
 * connection) and refuses every refund transfer leg, so only the scenario's
 * fresh ephemeral database is affected.
 */

import { type Client, createClient } from "@libsql/client";
import { log } from "./log.ts";

/** The E2E-specific trigger name, so it can never collide with app schema. */
export const REFUSE_REFUND_TRANSFERS_TRIGGER = "e2e_refuse_refund_transfers";

/** The databases this fault can be installed against. */
export interface FaultableDatabase {
  /** The exact libsql URL of the app server's fresh database. */
  dbUrl: string;
}

export interface InstalledFault {
  /** Drop the trigger and close the connection. Safe to call twice. */
  remove(): Promise<void>;
}

/**
 * Make refund-ledger inserts fail at SQLite's real write boundary — the same
 * proven condition as the deterministic suite's refund-safety fault. Sales and
 * ordinary reads stay available, so the provider can return the money while
 * the application's atomic refund transfer group rolls back: exactly the
 * production failure the recovery journey exercises.
 */
export const refuseRefundTransfers = async (
  server: FaultableDatabase,
): Promise<InstalledFault> => {
  const client: Client = createClient({ url: server.dbUrl });
  await client.execute(`
    CREATE TRIGGER ${REFUSE_REFUND_TRANSFERS_TRIGGER}
    BEFORE INSERT ON transfers
    WHEN substr(NEW.kind, 1, 7) = 'refund_'
    BEGIN
      SELECT RAISE(ABORT, 'refund ledger unavailable in the live harness');
    END
  `);
  log(`  installed the refund-transfer refusal fault on ${server.dbUrl}`);
  let removed = false;
  return {
    remove: async (): Promise<void> => {
      if (removed) return;
      removed = true;
      try {
        await client.execute(
          `DROP TRIGGER IF EXISTS ${REFUSE_REFUND_TRANSFERS_TRIGGER}`,
        );
      } finally {
        client.close();
      }
      log("  removed the refund-transfer refusal fault");
    },
  };
};

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { getDb, queryOne } from "#db/client.ts";
import workMigration from "#db/migrations/2026-10-11_registration_notification_work.ts";
import { applySchemaChanges, syncIndexes } from "#db/migrations/schema-sync.ts";
import { reserveSession } from "#db/processed-payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";
import { bookedWithPayment } from "#test-utils/processed-payments.ts";

// The backfill touches none of the schema-sync members; only the schema
// bookkeeping it can reach via `applySchemaChanges`/`syncIndexes` is live.
const context = buildMigrationContext({ applySchemaChanges, syncIndexes });

const runMigration = () => workMigration(context).up();

const workRow = async (sessionId: string) =>
  queryOne<{
    attendee_id: number | null;
    claimed_at: string | null;
    created_at: string;
    delivered_at: string | null;
  }>(
    "SELECT attendee_id, claimed_at, created_at, delivered_at FROM registration_notification_work WHERE session_index = ?",
    [await hmacHash(sessionId)],
  );

describeWithEnv(
  "db > migrations > 2026-10-11_registration_notification_work",
  { db: true },
  () => {
    test("stamps an existing completed booking delivered", async () => {
      const attendeeId = await bookedWithPayment(
        "cs_work_backfill_done",
        "pi_work_backfill",
      );

      await runMigration();

      const row = await workRow("cs_work_backfill_done");
      expect(row).toMatchObject({
        attendee_id: attendeeId,
        claimed_at: null,
      });
      // The delivered stamp is what the replay paths read: without it the
      // booking's first replay would notify the buyer again.
      expect(row?.delivered_at).not.toBeNull();
      // The row was born at the booking's own completion time.
      const processed = await getDb().batch([
        {
          args: ["cs_work_backfill_done"],
          sql: "SELECT processed_at FROM processed_payments WHERE payment_session_id = ?",
        },
      ]);
      expect(row?.created_at).toBe(processed[0]!.rows[0]!.processed_at);
    });

    test("leaves an unfinished booking unstamped so its replay resumes it", async () => {
      // A reserved session with no attendee: money arrived, the booking never
      // did, and the backfill must not claim the notification ran.
      await reserveSession("cs_work_backfill_unfinished");

      await runMigration();

      expect(await workRow("cs_work_backfill_unfinished")).toBeNull();
    });
  },
);

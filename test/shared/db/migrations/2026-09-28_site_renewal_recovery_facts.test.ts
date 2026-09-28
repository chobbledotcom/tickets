import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import siteRenewalRecoveryMigration from "#db/migrations/2026-09-28_site_renewal_recovery_facts.ts";
import { applySchemaChanges } from "#db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges });

const runMigration = () => siteRenewalRecoveryMigration(context).up();

describeWithEnv(
  "db > migrations > 2026-09-28_site_renewal_recovery_facts",
  { db: true },
  () => {
    test("backfills each booking line's site term from its plan", async () => {
      // A 3-month plan with a 2-unit line and a plain line beside it.
      await getDb().batch(
        [
          `INSERT INTO listings (created, max_attendees, initial_site_months, name)
           VALUES ('2026-01-01T00:00:00Z', 100, 3, 'Site Plan')`,
          `INSERT INTO listings (created, max_attendees, initial_site_months, name)
           VALUES ('2026-01-01T00:00:00Z', 100, 0, 'Plain Entry')`,
          `INSERT INTO attendees (created, kind, pii_blob, ticket_token_index)
           VALUES ('2026-01-01T00:00:00Z', 'attendee', '{}', 'x')`,
        ],
        "write",
      );
      const { rows: listings } = await getDb().execute(
        "SELECT id, initial_site_months FROM listings ORDER BY id",
      );
      const planId = Number(listings[0]?.id);
      const plainId = Number(listings[1]?.id);
      const { rows: attendees } = await getDb().execute(
        "SELECT id FROM attendees",
      );
      const attendeeId = Number(attendees[0]?.id);

      await getDb().execute({
        args: [planId, attendeeId, 2],
        sql: `INSERT INTO listing_attendees (listing_id, attendee_id, quantity, site_months)
              VALUES (?, ?, ?, 0)`,
      });
      await getDb().execute({
        args: [plainId, attendeeId, 1],
        sql: `INSERT INTO listing_attendees (listing_id, attendee_id, quantity, site_months)
              VALUES (?, ?, ?, 0)`,
      });

      await runMigration();

      const { rows } = await getDb().execute(
        `SELECT listing_id, site_months
           FROM listing_attendees
          ORDER BY listing_id`,
      );
      // The plan line carries months × quantity; the plain line none.
      expect(
        rows.map((row) => [Number(row.listing_id), Number(row.site_months)]),
      ).toEqual([
        [planId, 6],
        [plainId, 0],
      ]);
    });
  },
);

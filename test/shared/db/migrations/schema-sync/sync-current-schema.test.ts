import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { TRIGGERS } from "#db/migrations/schema/triggers.ts";
import { syncCurrentSchema } from "#db/migrations/schema-sync.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import {
  readListingAggregates,
  readModifierAggregates,
  triggerNames,
} from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { insertModifierWithUsages } from "#test-utils/db-helpers/modifier-usages.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";
import { logLogged, useDebugLogSpy } from "#test-utils/debug-log.ts";
import { expectIndexRepaired } from "#test-utils/migration-index-repair.ts";

/** Zero one stored aggregate row, run the sync, and assert the row its
 *  backfill rebuilt. */
const expectBackfilled = async <T>(
  zero: SqlStatement,
  read: () => Promise<T>,
  expected: T,
): Promise<void> => {
  await getDb().execute(zero);

  await syncCurrentSchema();

  expect(await read()).toEqual(expected);
};

/**
 * syncCurrentSchema is the migration orchestrator: every step it coordinates is
 * a no-op on an already-current database, so a dropped `await` or a deleted
 * step line survives any "happy path still works" test. Each test here drifts
 * one thing a step owns — a dropped index, a dropped trigger, blanked
 * aggregates — and asserts the sync alone repairs it; the log test pins the
 * step announcements themselves.
 */
describeWithEnv("db > migrations > syncCurrentSchema", { db: true }, () => {
  const debugSpy = useDebugLogSpy();

  test("recreates a declared index that is missing from the live database", async () => {
    // applySchemaChanges only creates tables and columns — index creation is
    // syncIndexes' job alone, so a dropped index must come back through it.
    await expectIndexRepaired(
      "idx_modifier_usages_modifier",
      syncCurrentSchema,
    );
  });

  test("recreates declared triggers that are missing from the live database", async () => {
    await getDb().execute(
      sql`DROP TRIGGER IF EXISTS trg_listing_attendees_aggregates_insert`,
    );
    expect(
      (await triggerNames()).has("trg_listing_attendees_aggregates_insert"),
    ).toBe(false);

    await syncCurrentSchema();

    const live = await triggerNames();
    for (const trigger of TRIGGERS) {
      expect(live.has(trigger.name)).toBe(true);
    }
  });

  test("backfills listing aggregates from listing_attendees", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    await getDb().execute(
      sql`INSERT INTO listing_attendees (listing_id, attendee_id, quantity) VALUES (${listing.id}, 1, 3)`,
    );
    // Blank the aggregates the way a pre-backfill database would carry them
    // (the insert triggers keep them current, so they must be zeroed after).
    await expectBackfilled(
      sql`UPDATE listings SET booked_quantity = 0, tickets_count = 0 WHERE id = ${listing.id}`,
      () => readListingAggregates(listing.id),
      { booked_quantity: 3, tickets_count: 1 },
    );
  });

  test("backfills modifier aggregates from modifier_usages", async () => {
    const modifier = await insertModifierWithUsages({ name: "Sync backfill" });

    await expectBackfilled(
      sql`UPDATE modifiers SET total_uses = 0, usage_count = 0 WHERE id = ${modifier.id}`,
      () => readModifierAggregates(modifier.id),
      { total_uses: 5, usage_count: 2 },
    );
  });

  test("backfills answer aggregates from attendee_answers", async () => {
    const { answerId, questionId } = await createQuestionWithAnswer();
    await getDb().execute(
      sql`INSERT INTO attendee_answers (attendee_id, question_id, answer_id) VALUES (${1}, ${questionId}, ${answerId})`,
    );

    await expectBackfilled(
      sql`UPDATE answers SET times_selected = 0 WHERE id = ${answerId}`,
      async () => {
        const result = await getDb().execute(
          sql`SELECT times_selected FROM answers WHERE id = ${answerId}`,
        );
        return Number(result.rows[0]!.times_selected);
      },
      1,
    );
  });

  test("announces every step in the debug log, including the legacy-rename preamble", async () => {
    let repaired = false;
    await syncCurrentSchema(async () => {
      repaired = true;
    });
    expect(repaired).toBe(true);

    const steps = [
      "Step 0: repairing legacy schema renames before schema apply...",
      "Step 1: applying schema changes...",
      "Step 2: syncing indexes...",
      "Step 3: backfilling listing_attendees...",
      "Step 4: dropping deprecated attendee columns...",
      "Step 5: syncing triggers...",
      "Step 6: backfilling listing aggregates...",
      "Step 7: backfilling modifier aggregates...",
      "Step 8: backfilling answer aggregates...",
    ];
    for (const step of steps) {
      expect(logLogged(debugSpy, `[Migration] ${step}`)).toBe(true);
    }
  });
});

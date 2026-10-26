import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { TRIGGERS } from "#db/migrations/schema/triggers.ts";
import { syncCurrentSchema } from "#db/migrations/schema-sync.ts";
import {
  readListingAggregates,
  readModifierAggregates,
  triggerNames,
} from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";
import { logLogged, useDebugLogSpy } from "#test-utils/debug-log.ts";
import { indexExists } from "#test-utils/migrations.ts";
import { insertModifier, insertModifierUsage } from "#test-utils/modifiers.ts";

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
    await getDb().execute("DROP INDEX IF EXISTS idx_modifier_usages_modifier");
    expect(await indexExists("idx_modifier_usages_modifier")).toBe(false);

    await syncCurrentSchema();

    expect(await indexExists("idx_modifier_usages_modifier")).toBe(true);
  });

  test("recreates declared triggers that are missing from the live database", async () => {
    await getDb().execute(
      "DROP TRIGGER IF EXISTS trg_listing_attendees_aggregates_insert",
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
    await getDb().execute({
      args: [listing.id],
      sql: "INSERT INTO listing_attendees (listing_id, attendee_id, quantity) VALUES (?, 1, 3)",
    });
    // Blank the aggregates the way a pre-backfill database would carry them
    // (the insert triggers keep them current, so they must be zeroed after).
    await getDb().execute({
      args: [listing.id],
      sql: "UPDATE listings SET booked_quantity = 0, tickets_count = 0 WHERE id = ?",
    });

    await syncCurrentSchema();

    expect(await readListingAggregates(listing.id)).toEqual({
      booked_quantity: 3,
      tickets_count: 1,
    });
  });

  test("backfills modifier aggregates from modifier_usages", async () => {
    const modifier = await insertModifier({ name: "Sync backfill" });
    await insertModifierUsage(modifier.id, 1, 3, 1500);
    await insertModifierUsage(modifier.id, 2, 2, 1000);
    await getDb().execute({
      args: [modifier.id],
      sql: "UPDATE modifiers SET total_uses = 0, usage_count = 0 WHERE id = ?",
    });

    await syncCurrentSchema();

    expect(await readModifierAggregates(modifier.id)).toEqual({
      total_uses: 5,
      usage_count: 2,
    });
  });

  test("backfills answer aggregates from attendee_answers", async () => {
    const { answerId, questionId } = await createQuestionWithAnswer();
    await getDb().execute({
      args: [1, questionId, answerId],
      sql: "INSERT INTO attendee_answers (attendee_id, question_id, answer_id) VALUES (?, ?, ?)",
    });
    await getDb().execute({
      args: [answerId],
      sql: "UPDATE answers SET times_selected = 0 WHERE id = ?",
    });

    await syncCurrentSchema();

    const result = await getDb().execute({
      args: [answerId],
      sql: "SELECT times_selected FROM answers WHERE id = ?",
    });
    expect(Number(result.rows[0]!.times_selected)).toBe(1);
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

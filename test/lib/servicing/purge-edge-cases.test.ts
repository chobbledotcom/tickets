/**
 * Servicing edge cases — purge edge cases.
 *
 * The orphan-purge path (§15) is exercised against the real listing-deletion
 * lifecycle, the cutoff boundary, and the dependent-row cascade — including
 * the `system_notes` gap the live `ORPHAN_DEPENDENT_TABLES` list omits.
 *
 * Implementation contract (test-first):
 *   - `purgeOrphanedAttendees` must delete `system_notes` rows for swept
 *     orphans (the live `ORPHAN_DEPENDENT_TABLES` list omits this table — the
 *     test pins the contract so a fix lands alongside the implementation).
 *   - A cost-bearing servicing event purged as an orphan must reverse its cost
 *     legs (the purge path currently bypasses `deleteServicingEvent`, so the
 *     §22 "deleting reverses cost legs" contract does NOT hold for orphans).
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  countOrphanedAttendees,
  purgeOrphanedAttendees,
} from "#shared/db/orphan-attendees.ts";
import { nowIso, nowMs } from "#shared/now.ts";
import {
  attendeeExists,
  childRowCount,
  createServicingHold,
  createTestListing,
  describeWithEnv,
  recordServiceCost,
} from "#test-utils";

// jscpd:ignore-end

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgoIso = (days: number): string =>
  new Date(nowMs() - days * DAY_MS).toISOString();

/** Drop a servicing event's booking link and backdate its `created` to
 *  `daysAgo` — the orphan state the purge sweeps. */
const orphanServicingEvent = async (
  id: number,
  daysAgo = 30,
): Promise<void> => {
  await getDb().execute({
    args: [id],
    sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
  });
  await getDb().execute({
    args: [daysAgoIso(daysAgo), id],
    sql: "UPDATE attendees SET created = ? WHERE id = ?",
  });
};

/** Insert a system_notes row for an attendee (the table the purge omits). */
const attachSystemNote = async (attendeeId: number): Promise<void> => {
  await getDb().execute({
    args: [attendeeId],
    sql: `INSERT INTO system_notes (attendee_id, type, note, created)
          VALUES (?, 'system', 'x', '2026-01-01T00:00:00Z')`,
  });
};

describeWithEnv("servicing edge cases — purge", { db: true }, () => {
  test("a servicing orphan created exactly at the cutoff survives; one ms earlier is swept", async () => {
    const cutoff = nowIso();
    // One orphan clearly past the cutoff (swept).
    const { id: oldId } = await createServicingHold();
    await orphanServicingEvent(oldId, 30);
    // One orphan at the boundary (created == cutoff; NOT swept — strict <).
    const { id: edgeId } = await createServicingHold();
    await getDb().execute({
      args: [edgeId],
      sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
    });
    await getDb().execute({
      args: [cutoff, edgeId],
      sql: "UPDATE attendees SET created = ? WHERE id = ?",
    });
    expect(await countOrphanedAttendees(cutoff)).toBeGreaterThanOrEqual(1);
    await purgeOrphanedAttendees(cutoff);
    expect(await attendeeExists(oldId)).toBe(false);
    // The boundary row survives — the purge predicate is `created < cutoff`.
    expect(await attendeeExists(edgeId)).toBe(true);
  });

  test("a servicing orphan's attendee_answers are swept by the purge", async () => {
    const { id } = await createServicingHold();
    await orphanServicingEvent(id);
    // Attach an answer so the sweep has something to delete.
    const { getDb: db } = await import("#shared/db/client.ts");
    await db().execute({
      args: [id, 1, 1],
      sql: "INSERT INTO attendee_answers (attendee_id, question_id, answer_id) VALUES (?, ?, ?)",
    });
    expect(await childRowCount("attendee_answers", id)).toBe(1);
    await purgeOrphanedAttendees(nowIso());
    expect(await childRowCount("attendee_answers", id)).toBe(0);
  });

  test("a servicing orphan's system_notes are swept (pins the missing-table contract)", async () => {
    const { id } = await createServicingHold();
    await orphanServicingEvent(id);
    await attachSystemNote(id);
    expect(await childRowCount("system_notes", id)).toBe(1);
    await purgeOrphanedAttendees(nowIso());
    // The live ORPHAN_DEPENDENT_TABLES list omits system_notes — this test
    // pins the contract that the purge MUST clear it (and will fail until
    // the production list is fixed).
    expect(await childRowCount("system_notes", id)).toBe(0);
  });

  test("the purge sweeps both a servicing orphan and an attendee orphan in one batch", async () => {
    // Mixed-kind sweep: the purge is kind-agnostic and removes both.
    const { id: servicingId } = await createServicingHold();
    await orphanServicingEvent(servicingId);
    const { createRealAttendee } = await import("#test-utils");
    const { attendee: real } = await createRealAttendee();
    await getDb().execute({
      args: [real.id],
      sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
    });
    await getDb().execute({
      args: [daysAgoIso(30), real.id],
      sql: "UPDATE attendees SET created = ? WHERE id = ?",
    });
    expect(await countOrphanedAttendees(nowIso())).toBeGreaterThanOrEqual(2);
    await purgeOrphanedAttendees(nowIso());
    expect(await attendeeExists(servicingId)).toBe(false);
    expect(await attendeeExists(real.id)).toBe(false);
  });

  test("a cost-bearing servicing event purged as an orphan leaves its cost legs as history", async () => {
    // The transfers ledger is append-only history — the purge never touches
    // it. A cost-bearing servicing event's `service_cost` legs remain in the
    // table as orphaned history, the same way sale legs for a deleted listing
    // remain. The ledger UI shows "Deleted listing" for the unresolved account.
    const { id, listing } = await createServicingHold();
    await recordServiceCost({
      amount: 9000,
      listingId: listing.id,
      memo: "Boiler part",
      occurredAt: "2026-07-01T00:00:00.000Z",
      servicingId: id,
    });
    const { allTransfers } = await import("#shared/accounting/queries.ts");
    const legsBefore = (await allTransfers()).filter(
      (t) => t.kind === "service_cost",
    );
    expect(legsBefore.length).toBe(1);
    await orphanServicingEvent(id);
    await purgeOrphanedAttendees(nowIso());
    // The attendee row is gone, but the cost legs are untouched — they're
    // orphaned history in the append-only ledger.
    const legsAfter = (await allTransfers()).filter(
      (t) => t.kind === "service_cost",
    );
    expect(legsAfter.length).toBe(1);
    expect(legsAfter[0]!.amount).toBe(9000);
  });

  test("deactivating a listing does NOT orphan its servicing event (only deletion does)", async () => {
    const listing = await createTestListing({ maxAttendees: 10, name: "L" });
    const { id } = await createServicingHold({ listing: { name: "L" } });
    const { deactivateTestListing } = await import("#test-utils");
    await deactivateTestListing(listing.id);
    // The listing still exists (just inactive); the attendee is not an orphan.
    expect(await attendeeExists(id)).toBe(true);
    expect(await childRowCount("listing_attendees", id)).toBe(1);
    expect(await countOrphanedAttendees(nowIso())).toBe(0);
  });
});

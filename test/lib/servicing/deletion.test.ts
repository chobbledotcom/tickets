/**
 * Servicing §15 — deletion & orphan purge.
 *
 * Deleting a servicing event reuses `deleteAttendee` (it's an attendee row):
 * the attendee, its `listing_attendees`, and its `attendee_answers` are
 * cleared, and capacity is restored (§2). The orphan purge — which removes an
 * attendee whose only listing was deleted — sweeps servicing events past the
 * cutoff too, parity with attendee orphan handling.
 *
 * Implementation contract (test-first):
 *   - `deleteServicingEvent(id)` delegates to the shared `deleteAttendee` (no
 *     bespoke cascade).
 *   - `purgeOrphanedAttendees` is kind-agnostic: a servicing row with no
 *     `listing_attendees` link is swept on the same cutoff as an attendee.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SERVICING_KIND } from "#shared/db/attendees/kind.ts";
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
  deleteServicingEvent,
  describeWithEnv,
  expectRejects,
  getServicingEvent,
  kindOf,
  servicingRowsForListing,
} from "#test-utils";

// jscpd:ignore-end

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgoIso = (days: number): string =>
  new Date(nowMs() - days * DAY_MS).toISOString();

/** Drop a servicing event's booking link and backdate its `created` past the
 *  purge cutoff — the orphan state the purge sweeps. */
const orphanServicingEvent = async (id: number): Promise<void> => {
  await getDb().execute({
    args: [id],
    sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
  });
  await getDb().execute({
    args: [daysAgoIso(30), id],
    sql: "UPDATE attendees SET created = ? WHERE id = ?",
  });
};

describeWithEnv("servicing §15 — deletion & orphan purge", { db: true }, () => {
  test("deleting a servicing event removes it and its dependent rows", async () => {
    const { id, listing } = await createServicingHold({ quantity: 2 });
    expect(await childRowCount("listing_attendees", id)).toBe(1);
    await deleteServicingEvent(id);
    expect(await attendeeExists(id)).toBe(false);
    expect(await childRowCount("listing_attendees", id)).toBe(0);
    expect(await childRowCount("attendee_answers", id)).toBe(0);
    expect((await servicingRowsForListing(listing.id)).length).toBe(0);
  });

  test("orphan purge sweeps a servicing event with no bookings past the cutoff", async () => {
    const { id } = await createServicingHold();
    await orphanServicingEvent(id);
    expect(await countOrphanedAttendees(nowIso())).toBeGreaterThanOrEqual(1);
    await purgeOrphanedAttendees(nowIso());
    expect(await attendeeExists(id)).toBe(false);
  });

  test("an orphaned servicing event can still be loaded for repair before purge", async () => {
    const { id } = await createServicingHold();
    await orphanServicingEvent(id);
    const event = await getServicingEvent(id);
    expect(event?.id).toBe(id);
    expect(event?.bookings).toEqual([]);
  });

  test("a servicing orphan's kind is preserved by the purge check (kind-agnostic sweep)", async () => {
    const { id } = await createServicingHold();
    await orphanServicingEvent(id);
    expect(await kindOf(id)).toBe(SERVICING_KIND);
    expect(await countOrphanedAttendees(nowIso())).toBeGreaterThanOrEqual(1);
  });

  test("deleting a missing servicing event reports not found", async () => {
    await expectRejects(deleteServicingEvent(999_999), /not found/);
  });
});

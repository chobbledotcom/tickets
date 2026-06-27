/**
 * Servicing §3/§4 — create/update atomicity (compensating rollback).
 *
 * `createServicingEvent` commits the attendee + bookings in one atomic batch,
 * then saves answers and logs activity in a separate batch; `updateServicingEvent`
 * edits bookings in one batch then saves answers in another. Batches don't nest
 * reliably on the edge runtime, so neither can wrap the whole thing in one outer
 * transaction. Instead, a failed post-create/post-edit side effect is compensated
 * — the created attendee is deleted (create), or the pre-edit state is restored
 * (update) — so no half-saved service event ever remains.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  createDailyTestListing,
  createTestListing,
  createTestServicingEvent,
  describeWithEnv,
  expectRejects,
  getServicingEvent,
  servicingRowsForListing,
  updateServicingEvent,
} from "#test-utils";

// jscpd:ignore-end

/**
 * Make the FIRST `attendee_answers` batch fail (the answer save), then delegate
 * every subsequent batch — including the compensating delete/restore — so the
 * create/update compensation runs against a working client. Swaps the libsql
 * client's `batch` method in place (module namespaces are frozen, but the
 * client instance's method is configurable) and discriminates by SQL content.
 */
const withAnswerSaveFailure = async (
  body: () => Promise<void>,
): Promise<void> => {
  const db = getDb();
  const realBatch = db.batch;
  let poisoned = true;
  db.batch = ((
    statements: { sql: string }[],
    mode?: "read" | "write",
  ): Promise<unknown> => {
    const sqls = statements.map((s) => (typeof s === "string" ? s : s.sql));
    if (poisoned && sqls.some((sql) => sql.includes("attendee_answers"))) {
      poisoned = false;
      return Promise.reject(new Error("answer save boom"));
    }
    return realBatch.call(db, statements as never, mode);
  }) as typeof db.batch;
  try {
    await body();
  } finally {
    db.batch = realBatch;
  }
};

describeWithEnv(
  "servicing — create/update compensate on side-effect failure",
  { db: true },
  () => {
    test("create deletes the attendee when answer saving fails (no partial event)", async () => {
      const listing = await createTestListing({ maxAttendees: 10, name: "L" });
      await withAnswerSaveFailure(async () => {
        await expectRejects(
          createTestServicingEvent({
            bookings: [{ listingId: listing.id, quantity: 2 }],
            name: "Doomed Service",
            questionAnswers: [],
          }),
          /answer save boom/,
        );
      });
      // The compensating delete removed the attendee and its booking, so no
      // half-saved service event holds the listing's capacity.
      expect((await servicingRowsForListing(listing.id)).length).toBe(0);
      const { queryOne } = await import("#shared/db/client.ts");
      const row = await queryOne<{ c: number }>(
        "SELECT COUNT(*) AS c FROM attendees WHERE kind = 'servicing'",
      );
      expect(Number(row?.c ?? 0)).toBe(0);
    });

    test("update restores the prior state when answer saving fails (no half-applied edit)", async () => {
      // Uses a DAILY listing with a date so the restore path's `start_at`
      // branch (a booking with a set date) is covered alongside the dateless
      // test below (which covers the `null` start_at path).
      const listing = await createDailyTestListing({
        maxAttendees: 10,
        name: "Daily Room",
      });
      const event = await createTestServicingEvent({
        bookings: [{ date: "2099-07-01", listingId: listing.id, quantity: 2 }],
        name: "Original",
      });
      await withAnswerSaveFailure(async () => {
        await expectRejects(
          updateServicingEvent(event.id, {
            bookings: [
              { date: "2099-07-01", listingId: listing.id, quantity: 5 },
            ],
            name: "Changed",
            questionAnswers: [],
          }),
          /answer save boom/,
        );
      });
      // The edit (qty 2→5, name→Changed) was rolled back: the original booking
      // (qty 2) and name survive, so the edit didn't land half-applied.
      const after = await getServicingEvent(event.id);
      expect(after?.name).toBe("Original");
      expect(after?.bookings[0]?.quantity).toBe(2);
    });

    test("update restores a dateless (standard) listing booking when answer saving fails", async () => {
      // Standard listings have start_at = null, exercising the restore path's
      // null-date branch (desiredLinesFromExisting handles a null start_at by
      // setting date to null — the restore must not break on it).
      const { createTestServicingEvent, createTestListing } = await import(
        "#test-utils"
      );
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Standard Room",
      });
      const event = await createTestServicingEvent({
        bookings: [{ listingId: listing.id, quantity: 3 }],
        name: "Standard Hold",
      });
      await withAnswerSaveFailure(async () => {
        await expectRejects(
          updateServicingEvent(event.id, {
            bookings: [{ listingId: listing.id, quantity: 1 }],
            name: "Changed",
            questionAnswers: [],
          }),
          /answer save boom/,
        );
      });
      const after = await getServicingEvent(event.id);
      expect(after?.name).toBe("Standard Hold");
      expect(after?.bookings[0]?.quantity).toBe(3);
    });
  },
);

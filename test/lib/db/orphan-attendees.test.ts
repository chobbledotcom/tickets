/**
 * Tests for orphaned-attendee counting and purging.
 *
 * Orphans (attendees with no listing_attendees link) are created by direct SQL
 * so each test controls the `created` timestamp precisely. Non-orphans are made
 * through the real create path so they carry a genuine booking link.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb, insert, queryOne } from "#shared/db/client.ts";
import {
  countOrphanedAttendees,
  purgeOrphanedAttendees,
} from "#shared/db/orphan-attendees.ts";
import { nowIso, nowMs } from "#shared/now.ts";
import {
  createTestAttendeeDirect,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

const DAY_MS = 24 * 60 * 60 * 1000;

/** An ISO timestamp `days` in the past. */
const daysAgoIso = (days: number): string =>
  new Date(nowMs() - days * DAY_MS).toISOString();

/** Insert an attendee with no listing booking (an orphan), returning its id. */
const insertOrphan = async (createdIso: string): Promise<number> => {
  const result = await getDb().execute(
    insert("attendees", {
      created: createdIso,
      pii_blob: "",
      ticket_token_index: `orphan-${crypto.randomUUID()}`,
    }),
  );
  return Number(result.lastInsertRowid);
};

/** Is an attendee row with this id still present? */
const attendeeExists = async (id: number): Promise<boolean> => {
  const row = await queryOne<{ one: number }>(
    "SELECT 1 AS one FROM attendees WHERE id = ?",
    [id],
  );
  return row !== null;
};

/** Count rows in a child table for the given attendee. */
const childCount = async (table: string, attendeeId: number): Promise<number> =>
  (
    await queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE attendee_id = ?`,
      [attendeeId],
    )
  )?.count ?? 0;

describeWithEnv("db > orphan-attendees", { db: true }, () => {
  describe("countOrphanedAttendees", () => {
    test("counts an attendee with no listing booking", async () => {
      await insertOrphan(daysAgoIso(365));
      expect(await countOrphanedAttendees(nowIso())).toBe(1);
    });

    test("ignores an attendee that still has a booking", async () => {
      const listing = await createTestListing();
      await createTestAttendeeDirect(
        listing.id,
        "Booked",
        "booked@example.com",
      );
      expect(await countOrphanedAttendees(nowIso())).toBe(0);
    });

    test("ignores orphans newer than the cut-off", async () => {
      await insertOrphan(nowIso());
      const cutoff = new Date(nowMs() - 60_000).toISOString();
      expect(await countOrphanedAttendees(cutoff)).toBe(0);
    });
  });

  describe("purgeOrphanedAttendees", () => {
    test("deletes orphans older than the cut-off and returns the count", async () => {
      const id = await insertOrphan(daysAgoIso(365));
      const deleted = await purgeOrphanedAttendees(nowIso());
      expect(deleted).toBe(1);
      expect(await attendeeExists(id)).toBe(false);
    });

    test("keeps orphans newer than the cut-off", async () => {
      const id = await insertOrphan(nowIso());
      const cutoff = new Date(nowMs() - 60_000).toISOString();
      const deleted = await purgeOrphanedAttendees(cutoff);
      expect(deleted).toBe(0);
      expect(await attendeeExists(id)).toBe(true);
    });

    test("keeps attendees that still have a booking", async () => {
      const listing = await createTestListing();
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Booked",
        "booked@example.com",
      );
      await purgeOrphanedAttendees(nowIso());
      expect(await attendeeExists(attendee.id)).toBe(true);
    });

    test("removes service_costs rows whose servicing_attendee_id is an orphan", async () => {
      const id = await insertOrphan(daysAgoIso(365));
      await getDb().execute(
        insert("service_costs", {
          created: nowIso(),
          listing_id: 1,
          memo: "",
          occurred_at: nowIso(),
          servicing_attendee_id: id,
          transfer_id: 0, // dummy; SQLite does not enforce FKs by default
        }),
      );
      await purgeOrphanedAttendees(nowIso());
      const remaining = await queryOne<{ c: number }>(
        "SELECT COUNT(*) AS c FROM service_costs WHERE servicing_attendee_id = ?",
        [id],
      );
      expect(remaining?.c).toBe(0);
    });

    test("removes the orphan's dependent answer and payment rows", async () => {
      const id = await insertOrphan(daysAgoIso(365));
      await getDb().execute(
        insert("attendee_answers", {
          answer_id: 1,
          attendee_id: id,
          question_id: 1,
        }),
      );
      await getDb().execute(
        insert("processed_payments", {
          attendee_id: id,
          payment_session_id: `ps-orphan-${id}`,
          processed_at: nowIso(),
        }),
      );

      await purgeOrphanedAttendees(nowIso());

      expect(await childCount("attendee_answers", id)).toBe(0);
      expect(await childCount("processed_payments", id)).toBe(0);
    });
  });
});

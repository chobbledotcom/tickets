/**
 * Tests for orphaned-attendee counting and purging.
 *
 * Orphans (attendees with no listing_attendees link) are created by direct SQL
 * so each test controls the `created` timestamp precisely. Non-orphans are made
 * through the real create path so they carry a genuine booking link.
 */

import { assertExists } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { assignBuiltSite, insertBuiltSite } from "#shared/db/built-sites.ts";
import {
  execute,
  getDb,
  insert,
  queryOne,
  requireOne,
} from "#shared/db/client.ts";
import { createSystemNote, getNoteRows } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import {
  countPurgeableOrphanedAttendees,
  getOrphanPaymentWorkPage,
  purgeOrphanedAttendees,
} from "#shared/db/orphan-attendees.ts";
import { nowIso, nowMs } from "#shared/now.ts";
import { insertCheckoutStage } from "#test-utils/checkout-stages.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  CLAIM_MIRROR,
  REVIEW_MIRROR,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import {
  addProviderRefundTestCase,
  readyRefundTestState,
} from "#test-utils/provider-refund-cases.ts";
import { insertRefundConfirmationFixture } from "#test-utils/refund-confirmations.ts";

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

/** Give an attendee one payment row carrying the named blocking mirror. */
const addPaymentWork = async (
  attendeeId: number,
  protectedState: string,
): Promise<void> => {
  await getDb().execute(
    insert("processed_payments", {
      attendee_id: attendeeId,
      payment_session_id: `ps-held-${attendeeId}`,
      processed_at: nowIso(),
      protected_state: protectedState,
    }),
  );
};

/** Count rows in a child table for the given attendee. */
const childCount = async (
  table: string,
  attendeeId: number,
): Promise<number> => {
  const row = await requireOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE attendee_id = ?`,
    [attendeeId],
  );
  assertExists(row);
  return row.count;
};

describeWithEnv("db > orphan-attendees", { db: true }, () => {
  describe("countPurgeableOrphanedAttendees", () => {
    test("counts an attendee with no listing booking", async () => {
      await insertOrphan(daysAgoIso(365));
      expect(await countPurgeableOrphanedAttendees(nowIso())).toBe(1);
    });

    test("ignores an attendee that still has a booking", async () => {
      const listing = await createTestListing();
      await createTestAttendeeDirect(
        listing.id,
        "Booked",
        "booked@example.com",
      );
      expect(await countPurgeableOrphanedAttendees(nowIso())).toBe(0);
    });

    test("ignores orphans newer than the cut-off", async () => {
      await insertOrphan(nowIso());
      const cutoff = new Date(nowMs() - 60_000).toISOString();
      expect(await countPurgeableOrphanedAttendees(cutoff)).toBe(0);
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
      const remaining = await requireOne<{ c: number }>(
        "SELECT COUNT(*) AS c FROM service_costs WHERE servicing_attendee_id = ?",
        [id],
      );
      expect(remaining?.c).toBe(0);
    });

    test("removes the orphan's dependent rows", async () => {
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
      await createSystemNote(attendeeNotes(id), "orphan note");
      const confirmation = await insertRefundConfirmationFixture(id);

      await purgeOrphanedAttendees(nowIso());

      expect(await childCount("attendee_answers", id)).toBe(0);
      expect(await childCount("processed_payments", id)).toBe(0);
      expect(await childCount("refund_confirmations", id)).toBe(0);
      const remainingReferences = await queryOne<{ count: number }>(
        `SELECT COUNT(*) AS count
           FROM refund_confirmation_references AS reference
          WHERE reference.confirmation_identity = ?`,
        [confirmation.identity],
      );
      expect(remainingReferences?.count).toBe(0);
      expect(await getNoteRows("attendee", [id])).toEqual([]);
    });

    test("removes the orphan's checkout stage", async () => {
      const id = await insertOrphan(daysAgoIso(365));
      await insertCheckoutStage(id, "stage-orphan-purge");

      await purgeOrphanedAttendees(nowIso());

      expect(await childCount("checkout_stages", id)).toBe(0);
    });

    test("detaches a built site from an orphan before purging it", async () => {
      const id = await insertOrphan(daysAgoIso(365));
      const site = await insertBuiltSite(
        "Orphan site",
        "orphan-site.example.test",
        "",
        "",
        true,
      );
      await assignBuiltSite(site.id, id, 99);

      await purgeOrphanedAttendees(nowIso());

      expect(
        await queryOne<{ assigned_attendee_id: number | null }>(
          "SELECT assigned_attendee_id FROM built_sites WHERE id = ?",
          [site.id],
        ),
      ).toEqual({ assigned_attendee_id: null });
    });
  });

  describe("an orphan whose payment is still being worked on", () => {
    /** An orphan old enough to purge, holding one payment row the mirror says
     *  has refund work on it. A set-based purge can no more decrypt every
     *  orphan than the prune can, so this plaintext word is all it reads. */
    const heldOrphan = async (): Promise<number> => {
      const id = await insertOrphan(daysAgoIso(365));
      await addPaymentWork(id, CLAIM_MIRROR);
      return id;
    };

    test("lists each kind of blocking work in the owner recovery queue", async () => {
      const claimId = await insertOrphan(nowIso());
      await addPaymentWork(claimId, CLAIM_MIRROR);
      const reviewId = await insertOrphan(nowIso());
      await addPaymentWork(reviewId, REVIEW_MIRROR);
      const unrecordedId = await insertOrphan(nowIso());
      await addPaymentWork(unrecordedId, UNRECORDED_MIRROR);

      expect((await getOrphanPaymentWorkPage()).attendeeIds).toEqual([
        claimId,
        reviewId,
        unrecordedId,
      ]);
    });

    test("does not call a booked attendee or finished payment an orphan", async () => {
      await insertOrphan(daysAgoIso(365));
      const listing = await createTestListing();
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Booked",
        "booked@example.com",
      );
      await addPaymentWork(attendee.id, CLAIM_MIRROR);

      expect((await getOrphanPaymentWorkPage()).attendeeIds).toEqual([]);
    });

    test("is not offered up for purging", async () => {
      const id = await heldOrphan();
      // The count and the delete share one clause, so a page that offered to
      // remove this orphan would promise something the purge then refuses.
      expect(await countPurgeableOrphanedAttendees(nowIso())).toBe(0);
      expect(await attendeeExists(id)).toBe(true);
    });

    test("keeps the payment row that says money may be going back", async () => {
      const id = await heldOrphan();

      await purgeOrphanedAttendees(nowIso());

      expect(await attendeeExists(id)).toBe(true);
      expect(await childCount("processed_payments", id)).toBe(1);
    });

    test("keeps canonical refund work when the legacy mirror is clear", async () => {
      const id = await insertOrphan(daysAgoIso(365));
      const reference = "orphan-authority-ready";
      await finalizeProcessedPayment(
        `session-${reference}`,
        id,
        "tok",
        taggedPaymentReference(reference),
      );
      await addProviderRefundTestCase(
        reference,
        readyRefundTestState("orphan-authority-request"),
        "stripe",
      );

      expect(await countPurgeableOrphanedAttendees(nowIso())).toBe(0);
      expect((await getOrphanPaymentWorkPage()).attendeeIds).toEqual([id]);

      expect(await purgeOrphanedAttendees(nowIso())).toBe(0);
      expect(await attendeeExists(id)).toBe(true);
      expect(await childCount("processed_payments", id)).toBe(1);
    });

    test("goes as normal once the work on its payment is finished", async () => {
      const id = await heldOrphan();
      await execute(
        "UPDATE processed_payments SET protected_state = '' WHERE attendee_id = ?",
        [id],
      );

      await purgeOrphanedAttendees(nowIso());

      // Only live work holds an orphan back: having had a payment at all is no
      // reason to keep it for ever.
      expect(await attendeeExists(id)).toBe(false);
    });
  });
});

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getAllActivityLog,
  getListingActivityLog,
  logActivity,
} from "#shared/db/activityLog.ts";
import { createAttendeeAtomic } from "#shared/db/attendees/api.ts";
import {
  getAttendeeRaw,
  getAttendeesRaw,
} from "#shared/db/attendees/queries.ts";
import {
  markCheckoutStage,
  stageCheckout,
} from "#shared/db/checkout-stages.ts";
import { queryAll } from "#shared/db/client.ts";
import { deleteListing } from "#shared/db/listings/delete.ts";
import {
  getListingWithCount,
  listingsTable,
} from "#shared/db/listings/records.ts";
import {
  isSessionProcessed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { getAttendeeAnswersBatch } from "#shared/db/questions/attendee-answers/reads.ts";
import { saveAttendeeAnswers } from "#shared/db/questions/attendee-answers/save.ts";
import { listingQuestions } from "#shared/db/questions/queries.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttendee,
  expectNoDecryptedAttendees,
} from "#test-utils/db-helpers/attendees.ts";
import {
  assignTestAttributeOptions,
  createTestAttributeWithOptions,
} from "#test-utils/db-helpers/attributes.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { finalizeTestPaymentSession as finalizePaymentSession } from "#test-utils/db-helpers/processed-payments.ts";
import { withTestSession } from "#test-utils/session.ts";

describeWithEnv("db > listings", { db: true, triggers: true }, () => {
  describe("deleteListing", () => {
    test("removes listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await deleteListing(listing.id);

      const fetched = await getListingWithCount(listing.id);
      expect(fetched).toBeNull();
    });

    test("removes all attendees for the listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "John",
        "john@example.com",
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Jane",
        "jane@example.com",
      );

      await deleteListing(listing.id);

      await expectNoDecryptedAttendees(listing.id);
    });

    test("keeps the processed payment of an orphaned attendee", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );

      await reserveSession("sess_listing_delete");
      await finalizePaymentSession(
        "sess_listing_delete",
        attendee.id,
        ["tok-test"],
        "pi_listing_delete",
      );

      await deleteListing(listing.id);

      // The attendee is orphaned, not purged, so its payment record survives.
      const processed = await isSessionProcessed("sess_listing_delete");
      expect(processed?.attendee_id).toBe(attendee.id);
    });

    test("removes activity log entries for the listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await logActivity("Action for listing", listing.id);
      await logActivity("Another action", listing.id);
      await logActivity("Global action");

      await deleteListing(listing.id);

      const listingLog = await getListingActivityLog(listing.id);
      expect(listingLog).toEqual([]);

      const allLog = await withTestSession(() => getAllActivityLog());
      const messages = allLog.map((e) => e.message);
      expect(messages).not.toContain("Action for listing");
      expect(messages).not.toContain("Another action");
      expect(messages).toContain("Global action");
    });

    // Book one attendee onto two listings, with distinct quantities so an
    // untouched booking is provable by its own value. Returns both listings and
    // the (shared) attendee id.
    const bookAttendeeOnTwoListings = async () => {
      const listing1 = await createTestListing({ maxAttendees: 50 });
      const listing2 = await createTestListing({ maxAttendees: 50 });
      const result = await createAttendeeAtomic({
        bookings: [
          { listingId: listing1.id, quantity: 2 },
          { listingId: listing2.id, quantity: 3 },
        ],
        email: "multi@example.com",
        name: "Multi",
      });
      if (!result.success) throw new Error("failed to set up test attendee");
      return { attendeeId: result.attendees[0]!.id, listing1, listing2 };
    };

    test("preserves attendees linked to other listings", async () => {
      const { attendeeId, listing1, listing2 } =
        await bookAttendeeOnTwoListings();

      await deleteListing(listing1.id);

      // The deleted listing's booking link is gone …
      expect(await getAttendeesRaw(listing1.id)).toEqual([]);
      // … while the other listing keeps the same attendee, with its own
      // booking quantity (3) untouched.
      const remaining = await getAttendeesRaw(listing2.id);
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.id).toBe(attendeeId);
      expect(remaining[0]!.quantity).toBe(3);
    });

    test("keeps the shared attendee's answers when one listing is deleted", async () => {
      const { attendeeId, listing1 } = await bookAttendeeOnTwoListings();
      const question = await questionsTable.insert({
        displayType: "radio",
        text: "Meal choice?",
      });
      const answer = await answersTable.insert({
        questionId: question.id,
        sortOrder: 0,
        text: "Vegan",
      });
      await saveAttendeeAnswers(new Map([[attendeeId, [answer.id]]]));

      await deleteListing(listing1.id);

      const answers = await getAttendeeAnswersBatch([attendeeId], {
        texts: false,
      });
      expect(answers.get(attendeeId)).toEqual([answer.id]);
    });

    test("removes the deleted listing's question assignments, keeping other listings'", async () => {
      const listing1 = await createTestListing({ maxAttendees: 50 });
      const listing2 = await createTestListing({ maxAttendees: 50 });
      const question = await questionsTable.insert({
        displayType: "radio",
        text: "Meal choice?",
      });
      await listingQuestions.setIds(listing1.id, [question.id]);
      await listingQuestions.setIds(listing2.id, [question.id]);

      await deleteListing(listing1.id);

      // Only the deleted listing's assignment is removed; listing2 keeps its
      // own. Leaving it behind would orphan the row (and, on databases migrated
      // from the legacy schema, the listing_questions → listings FK would have
      // blocked the delete entirely).
      const rows = await queryAll<{ listing_id: number }>(
        "SELECT listing_id FROM listing_questions ORDER BY listing_id",
      );
      expect(rows.map((r) => r.listing_id)).toEqual([listing2.id]);
    });

    test("removes the deleted listing's attribute assignments, keeping other listings'", async () => {
      const listing1 = await createTestListing({ maxAttendees: 50 });
      const listing2 = await createTestListing({ maxAttendees: 50 });
      const attribute = await createTestAttributeWithOptions("Difficulty", [
        "Easy",
      ]);
      await assignTestAttributeOptions(listing1.id, attribute.options);
      await assignTestAttributeOptions(listing2.id, attribute.options);

      await deleteListing(listing1.id);

      const rows = await queryAll<{ listing_id: number }>(
        "SELECT listing_id FROM listing_attribute_options ORDER BY listing_id",
      );
      expect(rows.map((r) => r.listing_id)).toEqual([listing2.id]);
    });

    test("keeps the shared attendee's processed payment when one listing is deleted", async () => {
      const { attendeeId, listing1 } = await bookAttendeeOnTwoListings();
      await reserveSession("sess_multi_listing");
      await finalizePaymentSession(
        "sess_multi_listing",
        attendeeId,
        ["tok-test"],
        "pi_multi_listing",
      );

      await deleteListing(listing1.id);

      const processed = await isSessionProcessed("sess_multi_listing");
      expect(processed?.attendee_id).toBe(attendeeId);
    });

    test("leaves an attendee orphaned rather than deleting it", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Solo",
        "solo@example.com",
      );

      await deleteListing(listing.id);

      // The listing no longer lists the attendee …
      expect(await getAttendeesRaw(listing.id)).toEqual([]);
      // … but the attendee row itself survives with no listing link (orphaned),
      // which getAttendeeRaw surfaces as listing_id 0.
      const orphan = await getAttendeeRaw(attendee.id);
      expect(orphan).not.toBeNull();
      expect(orphan!.id).toBe(attendee.id);
      expect(orphan!.listing_id).toBe(0);
    });

    test("keeps a pending checkout's rows, but cascades a resolved one's", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const intent = checkoutIntent({
        items: [
          checkoutItem({
            listingId: listing.id,
            name: listing.name,
            slug: listing.slug,
          }),
        ],
      });
      // Two checkouts staged onto the listing about to be deleted: one still
      // mid-payment (pending) and one that already resolved (booked).
      const pending = await stageCheckout("sess_del_pending", "stripe", intent);
      const booked = await stageCheckout("sess_del_booked", "stripe", intent);
      await markCheckoutStage("sess_del_booked", "booked");

      await deleteListing(listing.id);

      // The delete guard is a preflight, so a stage that lands in its race window
      // must not lose its rows — otherwise the paid order strands on an empty
      // record. The pending checkout's quantity-0 row survives; the resolved
      // one's is cascaded like any ordinary booking.
      const rowCount = async (attendeeId: number): Promise<number> =>
        (
          await queryAll<{ id: number }>(
            "SELECT id FROM listing_attendees WHERE attendee_id = ?",
            [attendeeId],
          )
        ).length;
      expect(await rowCount(pending.attendeeId)).toBe(1);
      expect(await rowCount(booked.attendeeId)).toBe(0);
    });

    test("invalidates cache", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      const before = await getListingWithCount(listing.id);
      expect(before).not.toBeNull();

      await listingsTable.deleteById(listing.id);

      const after = await getListingWithCount(listing.id);
      expect(after).toBeNull();
    });
  });
});

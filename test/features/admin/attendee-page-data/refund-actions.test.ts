/** Refund controls rendered from the attendee page's authoritative payment facts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { loadAttendeeForEdit } from "#routes/admin/attendee-page-data.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import {
  MANAGER,
  tabHtml,
} from "#test/features/admin/attendee-page/helpers.ts";
import {
  createPaidListing,
  createRefundableAttendee,
  markAsRefunded,
  setBookingLineQuantity,
  setupRefundTest,
} from "#test/features/admin/refunds-helpers.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookTestAttendee,
  createTestAttendee,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import {
  getCompleteRefundPaymentReferencesForAttendee,
  markProviderRefundsReturned,
} from "#test-utils/payment-references.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { recordQueries } from "#test-utils/record-queries.ts";
import { adminGet, withTestSession } from "#test-utils/session.ts";

const getListingPageHtml = async (listingId: number): Promise<string> => {
  const response = await adminGet(`/admin/listing/${listingId}`);
  expect(response.status).toBe(200);
  return response.text();
};

const createAttendeeAndGetHtml = async (
  listing: Awaited<ReturnType<typeof createTestListing>>,
  name: string,
  email: string,
): Promise<string> => {
  await createTestAttendee(listing.id, listing.slug, name, email);
  return getListingPageHtml(listing.id);
};

const expectCannotRefund = async (
  attendeeId: number,
  refunded: boolean,
): Promise<void> => {
  const loaded = await withTestSession(() => loadAttendeeForEdit(attendeeId));
  expect(loaded).toMatchObject({
    attendee: { id: attendeeId, refunded },
    canRefund: false,
  });
};

describeWithEnv("server (admin refund actions)", { db: true }, () => {
  test("shows the listing-level Refund All on a paid listing", async () => {
    const listing = await createPaidListing();
    await createRefundableAttendee(
      listing.id,
      "Paid User",
      "paid@example.com",
      "pi_ui_1",
    );

    const response = await adminGet(`/admin/listing/${listing.id}/actions`);
    await expectHtmlResponse(response, 200, "Refund All");
  });

  test("does not show Refund All for free listings", async () => {
    const listing = await createTestListing({ maxAttendees: 100 });
    const html = await createAttendeeAndGetHtml(
      listing,
      "Free User",
      "free@example.com",
    );
    expect(html).not.toContain("Refund All");
  });

  test("shows the per-attendee Refund action on a paid attendee's edit page", async () => {
    const listing = await createPaidListing();
    const attendee = await createRefundableAttendee(
      listing.id,
      "Paid User",
      "paid@example.com",
      "pi_edit_1",
    );
    const response = await adminGet(`/admin/attendees/${attendee.id}/actions`);
    const html = await expectHtmlResponse(response, 200);
    expect(html).toContain(`/admin/attendees/${attendee.id}/refund`);
  });

  test("hides Refund but keeps delete and resend when there is no payment", async () => {
    const listing = await createPaidListing();
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "No Payment User",
      "nopay@example.com",
    );
    const response = await adminGet(`/admin/attendees/${attendee.id}/actions`);
    const html = await expectHtmlResponse(response, 200);
    expect(html).not.toContain(`/admin/attendees/${attendee.id}/refund`);
    expect(html).toContain(`/admin/attendees/${attendee.id}/delete`);
    expect(html).toContain(
      `/admin/attendees/${attendee.id}/resend-notification`,
    );
  });

  test("loads canRefund as false without an active booking line", async () => {
    const ctx = await setupRefundTest("pi_no_quantity_action");
    await setBookingLineQuantity(ctx.attendee.id, ctx.listing.id, 0);

    await expectCannotRefund(ctx.attendee.id, false);
  });

  test("decides canRefund without asking about the booking again", async () => {
    const ctx = await setupRefundTest("pi_no_second_line_read");
    const seen: string[] = [];
    const restore = recordQueries(seen);
    try {
      await withTestSession(() => loadAttendeeForEdit(ctx.attendee.id));
    } finally {
      restore();
    }

    // The page loads every one of the attendee's lines; asking the database
    // whether one of them is a real booking would be asking twice.
    expect(
      seen.filter((sql) =>
        sql.includes("attendee_id = ? AND listing_id = ? AND quantity > 0"),
      ),
    ).toEqual([]);
  });

  test("loads canRefund as false once every charge is returned", async () => {
    const ctx = await setupRefundTest("pi_already_refunded_action");
    await markAsRefunded(ctx.attendee.id);

    await expectCannotRefund(ctx.attendee.id, true);
  });

  test("offers an unreturned charge after its sibling booking was refunded", async () => {
    const refundedListing = await createTestListing({});
    const openListing = await createTestListing({});
    const attendee = await bookTestAttendee(
      [refundedListing.id, openListing.id],
      "Two Orders",
      "two-orders@example.com",
    );
    const refundedSession = "sess-page-refunded-order";
    const openSession = "sess-page-open-order";
    await postListingSale({
      attendeeId: attendee.id,
      eventId: refundedSession,
      gross: 500,
      listingId: refundedListing.id,
    });
    await postListingSale({
      attendeeId: attendee.id,
      eventId: openSession,
      gross: 500,
      listingId: openListing.id,
    });
    await finalizeProcessedPayment(
      refundedSession,
      attendee.id,
      "",
      taggedPaymentReference("pi_page_refunded_order"),
    );
    await finalizeProcessedPayment(
      openSession,
      attendee.id,
      "",
      taggedPaymentReference("pi_page_open_order"),
    );
    const references =
      await getCompleteRefundPaymentReferencesForAttendee(attendee);
    const refunded = references.find(
      ({ reference }) => reference === "pi_page_refunded_order",
    );
    if (refunded === undefined) {
      throw new Error("The refunded order reference was not loaded");
    }
    await markProviderRefundsReturned([refunded]);
    await recordAttendeeRefund(attendee.id, [refunded]);

    expect(
      await withTestSession(() => loadAttendeeForEdit(attendee.id)),
    ).toMatchObject({ canRefund: true });
    const refundUrl = `/admin/attendees/${attendee.id}/refund`;
    expect(await tabHtml(attendee.id, "actions")).toContain(refundUrl);
    expect(await tabHtml(attendee.id, "actions", MANAGER)).not.toContain(
      refundUrl,
    );
  });
});

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { loadPaymentCasePage } from "#routes/admin/payments/data.ts";
import { getDb } from "#shared/db/client.ts";
import { recordPaymentCase } from "#shared/db/payments/cases.ts";
import { settings } from "#shared/db/settings.ts";
import {
  PAYMENT_INTENT,
  PAYMENT_TIME,
  paymentSessionInput,
  SESSION_RESOURCE,
} from "#test/shared/db/payments/fixtures.ts";
import {
  createLegacyAttendeePaymentCase,
  createPendingPayment,
} from "#test/shared/payment-runtime/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withTestSession } from "#test-utils/session.ts";

const currentCase = async (listingId: number, attendeeId: number | null) => {
  const session = { ...SESSION_RESOURCE, id: "data-payment-session" };
  const payment = await createPendingPayment({
    ...paymentSessionInput("data-payment", session),
    bookingIntent: {
      ...PAYMENT_INTENT,
      items: [{ e: listingId, p: 1_000, q: 1 }],
    },
  });
  await getDb().execute(
    "UPDATE payment_sessions SET attendee_id = ? WHERE id = ?",
    [attendeeId, payment.id],
  );
  return (
    await recordPaymentCase(
      {
        evidence: payment.bookingIntent,
        nextReconcileAt: null,
        paymentId: payment.id,
        reason: "partial_refund",
        resource: session,
        state: "needs_action",
      },
      PAYMENT_TIME,
    )
  ).paymentCase;
};

describeWithEnv("admin payment case data", { db: true }, () => {
  afterEach(() => settings.clearTestOverrides());

  test("returns null for a missing case", async () => {
    expect(await loadPaymentCasePage(999_999)).toBeNull();
  });

  test("loads current booking links and the attendee name", async () => {
    const listing = await createTestListing({ name: "Linked listing" });
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Linked buyer",
      "linked-buyer@example.com",
    );
    const paymentCase = await currentCase(listing.id, attendee.id);

    const data = await withTestSession(() =>
      loadPaymentCasePage(paymentCase.id),
    );

    expect(data).toMatchObject({
      attendee: { id: attendee.id, name: "Linked buyer" },
      listings: [{ id: listing.id, name: "Linked listing" }],
    });
  });

  test("loads older booking links from the attendee rows", async () => {
    const listing = await createTestListing({ name: "Older linked listing" });
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Older linked buyer",
      "older-linked@example.com",
    );
    const paymentCase = await createLegacyAttendeePaymentCase(
      "older-linked-payment",
      attendee.id,
    );

    const data = await withTestSession(() =>
      loadPaymentCasePage(paymentCase.id),
    );

    expect(data).toMatchObject({
      attendee: { id: attendee.id, name: "Older linked buyer" },
      listings: [{ id: listing.id, name: "Older linked listing" }],
    });
  });

  test("returns no older booking links without an attendee", async () => {
    const paymentCase = await createLegacyAttendeePaymentCase(
      "older-unlinked-payment",
    );
    await getDb().execute(
      "UPDATE payment_sessions SET attendee_id = NULL WHERE id = ?",
      [paymentCase.paymentId],
    );

    const data = await loadPaymentCasePage(paymentCase.id);

    expect(data).toMatchObject({ attendee: null, listings: [] });
  });

  test("omits a current listing that no longer exists", async () => {
    const paymentCase = await currentCase(999_999, null);

    const data = await loadPaymentCasePage(paymentCase.id);

    expect(data).toMatchObject({ attendee: null, listings: [] });
  });

  test("omits an attendee link when its stored attendee no longer exists", async () => {
    const listing = await createTestListing({ name: "Current listing" });
    const paymentCase = await currentCase(listing.id, 999_999);

    const data = await withTestSession(() =>
      loadPaymentCasePage(paymentCase.id),
    );

    expect(data).toMatchObject({
      attendee: null,
      listings: [{ id: listing.id, name: "Current listing" }],
    });
  });
});

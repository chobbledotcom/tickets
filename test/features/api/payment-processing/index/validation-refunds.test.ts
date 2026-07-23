/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { queryAll } from "#shared/db/client.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  intentFor,
  paidSession,
  stageSession,
} from "#test/features/api/payment-processing/staged-runtime.helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";

/* jscpd:ignore-end */

const expectRegistrationClosedRefund = async (
  sessionId: string,
  closeRegistration: (listingId: number) => Promise<unknown>,
  expectedError: string,
): Promise<void> => {
  await setupStripe();
  const listing = await createTestListing({ unitPrice: 1000 });
  const intent = intentFor(listing.id);
  await stageSession(sessionId, intent);
  await closeRegistration(listing.id);
  using _refund = stub(stripePaymentProvider, "refundPayment", () =>
    Promise.resolve("refunded" as const),
  );
  const result = await processPaymentSession(
    sessionId,
    paidSession(sessionId, intent),
  );
  expect(result).toMatchObject({
    error: expectedError,
    refundStatus: "refunded",
    status: 410,
    success: false,
  });
  expect(
    await queryAll("SELECT memo FROM transfers WHERE kind = 'refund_cash'"),
  ).toEqual([{ memo: "registration_closed" }]);
};

describeWithEnv("staged listing validation refunds", { db: true }, () => {
  test("records an inactive listing as an expected registration-closed refund", () =>
    expectRegistrationClosedRefund(
      "inactive-refund",
      deactivateTestListing,
      "This listing is no longer accepting registrations.",
    ));

  test("records a passed registration deadline as an expected refund", () =>
    expectRegistrationClosedRefund(
      "deadline-refund",
      (listingId) =>
        updateTestListing(listingId, { closesAt: "2000-01-01T00:00" }),
      "Sorry, registration closed while you were completing payment.",
    ));
});

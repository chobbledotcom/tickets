import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { queryAll, queryOne } from "#db/client.ts";
import { listingsTable } from "#db/listings/records.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import { handleRequest } from "#routes";
import { requireValue } from "#shared/required-value.ts";
import type {
  StripeCheckoutSession,
  StripeSubscription,
} from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import type { SubscriptionStatus } from "#shared/subscriptions/plan.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  signedMeta,
  singleItem,
  type TestListingOverrides,
} from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  stripeFirstInvoice,
  stripeSubscription,
  subscriptionItems,
} from "#test-utils/stripe/fixtures.ts";
import {
  type StartedSubscription,
  withSubscriptionStarted,
} from "#test-utils/stripe/subscription-checkout.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";

export const SESSION_ID = "cs_failed_subscription";
export const SUBSCRIPTION_ID = "sub_failed_subscription";

export const EXPECTED_PLACEHOLDER = {
  quantity: 0,
  recurring_interval: "month",
  recurring_price: 1200,
  recurring_tax: 200,
  subscription_id: SUBSCRIPTION_ID,
  subscription_status: "trialing",
};

export const startedCheckout = (listingId: number): StartedSubscription => ({
  session: {
    amount_total: 2000,
    id: SESSION_ID,
    metadata: signedMeta(
      {
        email: "member@example.com",
        items: singleItem(listingId, 2, 2000),
        name: "Member",
        tax_policy: JSON.stringify({
          mode: "calculate_from_total",
          rateBasisPoints: 2000,
        }),
      },
      2000,
    ),
  },
  subscription: {
    id: SUBSCRIPTION_ID,
    items: subscriptionItems("month", 600, 2),
    metadata: { listing_id: String(listingId) },
    status: "trialing",
  },
});

export const checkoutListingId = async (
  overrides: TestListingOverrides = {},
): Promise<number> => {
  const listing = await createTestListing({
    maxAttendees: 10,
    maxQuantity: 2,
    unitPrice: 1000,
    ...overrides,
  });
  if (overrides.active === false)
    await listingsTable.update(listing.id, { active: false });
  return listing.id;
};

export const deliver = () =>
  handleRequest(mockRequest(`/payment/success?session_id=${SESSION_ID}`));

export const storedPlans = (listingId: number) =>
  queryAll(
    `SELECT quantity, recurring_price, recurring_tax, recurring_interval,
          subscription_id, subscription_status
     FROM listing_attendees WHERE listing_id = ?`,
    [listingId],
  );

export const expectPlan = async (
  listingId: number,
  expected = EXPECTED_PLACEHOLDER,
): Promise<void> => {
  expect(await storedPlans(listingId)).toEqual([expected]);
};

export const placeholderOwner = async (listingId: number): Promise<number> => {
  const row = await queryOne<{ attendee_id: number }>(
    "SELECT attendee_id FROM listing_attendees WHERE listing_id = ?",
    [listingId],
  );
  return requireValue(row, "Failed checkout placeholder not found").attendee_id;
};

type ActionSpy = { readonly calls: readonly unknown[] };

export const expectActions = (
  cancel: ActionSpy,
  refund: ActionSpy,
  cancellations: number,
  refunds: number,
): void => {
  expect(cancel.calls).toHaveLength(cancellations);
  expect(refund.calls).toHaveLength(refunds);
};

export const expectStatuses = async (
  request: () => Promise<Response>,
  ...statuses: number[]
): Promise<void> => {
  for (const status of statuses) expect((await request()).status).toBe(status);
};

export const observedSubscription = (
  id: string,
  status: SubscriptionStatus,
): ProviderRead<StripeSubscription> => ({
  resource: stripeSubscription({ id, status }),
  status: "found",
});

export const withRejectedCheckout = (
  listingId: number,
  reason: "malformed charge" | "blank reference",
  foreign: boolean,
  body: (session: Partial<StripeCheckoutSession>) => Promise<void>,
): Promise<void> => {
  const started = startedCheckout(listingId);
  started.session.amount_total = reason === "malformed charge" ? null : 2000;
  if (foreign) {
    requireValue(
      started.session.metadata,
      "Checkout metadata not found",
    ).price_proof = `2000.${"A".repeat(44)}`;
  }
  if (reason === "blank reference") {
    started.invoice = stripeFirstInvoice();
    started.invoice.payments.data = [];
  }
  return withSubscriptionStarted(started, () => body(started.session));
};

export const withUntouchedSubscription = async (
  body: (listingId: number) => Promise<void>,
): Promise<void> => {
  await setupStripe();
  const listingId = await checkoutListingId();
  using cancel = stub(stripeApi, "cancelSubscription", () =>
    Promise.reject(new Error("A protected subscription must not cancel")),
  );
  using refund = stubRefundPayment("re_must_not_refund", 2000);
  await body(listingId);
  expectActions(cancel, refund, 0, 0);
};

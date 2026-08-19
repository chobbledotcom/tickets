import { stub } from "@std/testing/mock";
import type { RefundRequest } from "#payment/refund-attempt.ts";
import { handleRequest } from "#routes";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { foundCharge } from "#test-utils/payment-state.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import type { ListingWithCount } from "#types";

type VerifyEvent = Parameters<typeof stubWebhookVerify>[0];
interface Restorable extends Disposable {
  restore(): void;
}

export const postWebhook = async (
  event: VerifyEvent,
): Promise<readonly [Response, Restorable]> => {
  const verify = await stubWebhookVerify(event);
  return [
    await handleRequest(mockWebhookRequest({}, { "stripe-signature": "sig" })),
    verify,
  ] as const;
};

export const setupMismatchWithFailingRefund = async (
  price = 1000,
): Promise<{
  l: ListingWithCount;
  refundedStub: Restorable;
  refundStub: Restorable;
}> => {
  await setupStripe();
  const l = await createTestListing({ maxAttendees: 50, unitPrice: price });
  const { stripePaymentProvider } = await import("#shared/stripe-provider.ts");
  const refundStub = stub(
    stripePaymentProvider,
    "refundCharge",
    (_request: RefundRequest) =>
      Promise.resolve({ kind: "rejected", reason: "failed" } as const),
  );
  const refundedStub = stub(stripePaymentProvider, "readCharge", () =>
    Promise.resolve(foundCharge()),
  );
  return { l, refundedStub, refundStub };
};

export const setupMultiMismatchWithFailingRefund = async (): Promise<{
  first: ListingWithCount;
  items: string;
  refundedStub: Restorable;
  refundStub: Restorable;
  second: ListingWithCount;
}> => {
  const {
    l: first,
    refundedStub,
    refundStub,
  } = await setupMismatchWithFailingRefund();
  const second = await createTestListing({ maxAttendees: 50, unitPrice: 1000 });
  const items = JSON.stringify([
    { e: first.id, p: 1000, q: 1 },
    { e: second.id, p: 1000, q: 1 },
  ]);
  return { first, items, refundedStub, refundStub, second };
};

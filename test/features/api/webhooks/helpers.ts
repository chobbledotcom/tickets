import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import type { ListingWithCount } from "#shared/types.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";

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
  const refundStub = stub(stripePaymentProvider, "refundPayment", () =>
    Promise.resolve(false),
  );
  const refundedStub = stub(stripePaymentProvider, "isPaymentRefunded", () =>
    Promise.resolve(false),
  );
  return { l, refundedStub, refundStub };
};

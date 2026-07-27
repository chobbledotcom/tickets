import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";
import { getPaymentSessions } from "#shared/db/payments/sessions.ts";
import type { PaymentCheckoutCreateSnapshot } from "#shared/payment-checkout.ts";
import { preparePaymentCheckout } from "#shared/payment-runtime/create.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import type {
  CheckoutIntent,
  CheckoutItem,
  CheckoutSessionResult,
  PaymentProvider,
  ProviderCheckoutResult,
} from "#shared/payments.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import type { PaymentProviderType } from "#shared/types.ts";
import { required } from "#test-utils/required.ts";
import { submitTicketForm } from "./csrf.ts";
import { signedMeta } from "./factories.ts";
import { stubRetrieveCheckoutSession } from "./webhooks.ts";

/** A checkout line item with sensible defaults; override any field. */
export const checkoutItem = (
  overrides: Partial<CheckoutItem> = {},
): CheckoutItem => ({
  listingId: 1,
  name: "General",
  quantity: 1,
  slug: "general",
  unitPrice: 1000,
  ...overrides,
});

/** A checkout intent with sensible defaults; override any field. */
export const checkoutIntent = (
  overrides: Partial<CheckoutIntent> = {},
): CheckoutIntent => ({
  address: "",
  date: null,
  email: "buyer@example.com",
  items: [checkoutItem()],
  name: "Buyer",
  phone: "",
  special_instructions: "",
  ...overrides,
});

/** Build the exact prepared value handed to an internal provider creator. */
export const preparedCheckout = (
  intent: CheckoutIntent = checkoutIntent(),
  provider: PaymentProviderType = "stripe",
  localPaymentId = "local-payment-test",
  baseUrl = "http://localhost:3000",
): Promise<PaymentCheckoutCreateSnapshot> =>
  preparePaymentCheckout(provider, intent, baseUrl, localPaymentId);

/** Add the provider resource required by the internal creation result. */
export const providerCheckoutResult = (
  result: CheckoutSessionResult,
  provider: PaymentProviderType = "stripe",
): ProviderCheckoutResult =>
  result === null || "error" in result
    ? result
    : {
        ...result,
        session: PAYMENT_PROVIDER_RESOURCES[provider].session(result.sessionId),
      };

/** The checkout URL {@link stubCheckout} returns, so a test can assert a paid
 *  booking's response carries exactly the URL the stub produced (importing it
 *  keeps the stub's URL and the assertion in lockstep, not a magic string). */
export const STUB_CHECKOUT_URL = "https://stripe.example/checkout";

interface ProviderCheckoutStub {
  calls: () => number;
  checkout: Stub;
  getCaptured: () => PaymentCheckoutCreateSnapshot | undefined;
  requireCaptured: () => PaymentCheckoutCreateSnapshot;
}

type CheckoutResponse = (
  checkout: PaymentCheckoutCreateSnapshot,
  callNumber: number,
) => Promise<ProviderCheckoutResult>;

/** Stub one provider checkout method and keep the exact snapshot it receives. */
export const stubProviderCheckout = (
  provider: PaymentProvider,
  respond: CheckoutResponse,
): ProviderCheckoutStub => {
  let captured: PaymentCheckoutCreateSnapshot | undefined;
  let callNumber = 0;
  const checkout = stub(provider, "createCheckout", (value) => {
    captured = value;
    callNumber += 1;
    return respond(value, callNumber);
  });
  return {
    calls: () => checkout.calls.length,
    checkout,
    getCaptured: () => captured,
    requireCaptured: () => required(captured, "a provider checkout call"),
  };
};

/** A Square checkout whose first provider response is lost. */
export const stubUncertainSquareCheckout = (): ProviderCheckoutStub =>
  stubProviderCheckout(squarePaymentProvider, () => Promise.resolve(null));

interface BlockedSquareCheckoutStub extends ProviderCheckoutStub {
  releaseRetry: () => void;
  retryStarted: Promise<void>;
}

/** Lose the first Square response, then hold its successful retry in flight. */
export const stubBlockedSquareCheckoutRetry = (
  result: Extract<ProviderCheckoutResult, { sessionId: string }>,
): BlockedSquareCheckoutStub => {
  const retryStarted = Promise.withResolvers<void>();
  const releaseRetry = Promise.withResolvers<void>();
  const checkout = stubProviderCheckout(
    squarePaymentProvider,
    async (_value, callNumber) => {
      if (callNumber === 1) return null;
      retryStarted.resolve();
      await releaseRetry.promise;
      return result;
    },
  );
  return {
    ...checkout,
    releaseRetry: () => releaseRetry.resolve(),
    retryStarted: retryStarted.promise,
  };
};

/** Assert that an uncertain provider response remains ready to reconcile. */
export const expectPaymentCheckoutCreationDue = async (
  paymentId: string,
): Promise<void> => {
  const stored = (await getPaymentSessions([paymentId]))[0];
  expect(stored).toMatchObject({
    checkoutCreate: expect.any(Object),
    session: null,
    state: "created",
  });
  expect(stored?.nextReconcileAt).not.toBeNull();
};

/** Stub the checkout-session provider and capture the intent it was called
 * with — the shared "inspect what checkout would have charged" fixture
 * behind every test that never actually completes a paid session. The optional
 * `sessionId` labels the captured intent (defaults to `"cs_test"`). Returns
 * `checkout` (the mock, for `restore()`), `getCaptured()` (the intent handed
 * over), and `calls()` (how many times the provider was reached) so the
 * sold-out preflight case can assert it was never called. */
export const stubCheckout = (sessionId = "cs_test") =>
  stubProviderCheckout(stripePaymentProvider, () =>
    Promise.resolve({
      checkoutUrl: STUB_CHECKOUT_URL,
      session: PAYMENT_PROVIDER_RESOURCES.stripe.session(sessionId),
      sessionId,
    }),
  );

/** Submit a buyer's ticket form through a stubbed checkout provider, assert
 * the redirect succeeded, and return the checkout intent it captured — the
 * shared "what would checkout have charged" flow behind every test that
 * inspects the outgoing intent rather than completing a paid session. */
export const captureCheckoutSnapshot = async (
  listing: { id: number; slug: string },
  fields: Record<string, string> = {},
): Promise<PaymentCheckoutCreateSnapshot | undefined> => {
  const { checkout, getCaptured } = stubCheckout();
  try {
    const response = await submitTicketForm(listing.slug, {
      [`quantity_${listing.id}`]: "1",
      email: "buyer@example.com",
      name: "Buyer",
      ...fields,
    });
    expect([302, 303]).toContain(response.status);
    return getCaptured();
  } finally {
    checkout.restore();
  }
};

/** Stub the retrieved checkout session as the standard "John" buyer — the
 *  session shape the payment-flow suites share, varying only in the id, the
 *  items, and the agreed total. A paid session (the default) carries signed
 *  metadata and a payment intent; pass `paid: false` for the cancelled
 *  variant — unsigned metadata, no payment intent, and a zero total, as an
 *  abandoned checkout retrieves. */
export const johnCheckoutSession = (
  sessionId: string,
  opts:
    | { paid: false; items: string }
    | {
        paid?: true;
        items: string;
        amountTotal: number;
        paymentIntent: string;
      },
) =>
  opts.paid === false
    ? stubRetrieveCheckoutSession({
        amountTotal: 0,
        // Signed, so a cancelled checkout is still recognisably ours and the
        // page can offer the way back to the listing.
        metadata: signedMeta(
          { email: "john@example.com", items: opts.items, name: "John" },
          0,
        ),
        paymentIntent: null,
        paymentStatus: "unpaid",
        sessionId,
      })
    : stubRetrieveCheckoutSession({
        amountTotal: opts.amountTotal,
        email: "john@example.com",
        items: opts.items,
        name: "John",
        paymentIntent: opts.paymentIntent,
        sessionId,
      });

/** Find the captured intent's line item for `listing` and assert its
 *  `unitPrice` — the shared "this folded line was charged X" check behind
 *  every test that inspects the outgoing intent's per-line prices. Pass the
 *  captured intent (`getCaptured()`), the listing whose price to check, and the
 *  expected unit price in the smallest currency unit (e.g. pence). */
export const expectCapturedItemPriced = (
  checkout: PaymentCheckoutCreateSnapshot | undefined,
  listing: { name: string },
  unitPrice: number,
): void => {
  const line = checkout?.order.lines.find((item) => item.name === listing.name);
  expect(line?.amount).toBe(unitPrice);
};

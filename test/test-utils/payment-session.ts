import {
  isSessionRejection,
  type SessionRejection,
} from "#payment/validated-session.ts";
import type {
  ValidatedPaymentSession,
  WebhookSessionResult,
} from "#shared/payments.ts";
import { signedMeta, webhookMeta } from "#test-utils/factories.ts";

/**
 * Every metadata field the price signature covers, blank. The boundary hands
 * on this canonical shape — for a session and for a rejection alike — rather
 * than the provider's wire record, so a test spreads its own values over this
 * to state the whole expected metadata rather than only the parts it set.
 */
export const BLANK_SESSION_METADATA: ValidatedPaymentSession["metadata"] = {
  _origin: "",
  address: "",
  allocations: "",
  answer_ids: "",
  balance_attendee_id: "",
  date: "",
  day_count: "",
  email: "",
  items: "",
  modifiers: "",
  name: "",
  phone: "",
  price_proof: "",
  reservation_amount: "",
  site_token_index: "",
  special_instructions: "",
  text_answer_ids: "",
  thank_you_url: "",
};

/** A paid Stripe session with one valid charge reference. */
export const paidSession = (
  id: string,
  overrides: Partial<ValidatedPaymentSession> = {},
): ValidatedPaymentSession => ({
  amountTotal: 1000,
  currency: "GBP",
  id,
  metadata: webhookMeta({ name: "Buyer" }),
  paymentReference: `pi_${id}`,
  paymentStatus: "paid",
  provider: "stripe",
  ...overrides,
});

/** Narrow any provider session result to the session; fail the test on a
 *  rejection, a skip, a retry refusal, or null. */
export const asSession = (
  result: WebhookSessionResult,
): ValidatedPaymentSession => {
  if (
    result === null ||
    result === "skip" ||
    result === "retry" ||
    isSessionRejection(result)
  ) {
    throw new Error(`expected a session, got ${JSON.stringify(result)}`);
  }
  return result;
};

/** Makes the Stripe provider answer every session retrieval with this value —
 *  a session, a rejection, or null (a checkout it never heard of) — for as
 *  long as the test runs. */
export const stubSessionRetrieval = async (
  answer: ValidatedPaymentSession | SessionRejection | null,
): Promise<Disposable> => {
  const { stub } = await import("@std/testing/mock");
  const { stripePaymentProvider } = await import("#shared/stripe-provider.ts");
  return stub(stripePaymentProvider, "retrieveSession", () =>
    Promise.resolve(answer),
  );
};

/** One signed checkout line: the listing id, its unit price, and a quantity.
 *  A package line carries its edge tag (`k`) and package group (`r`) too. */
export type CheckoutLine = {
  e: number;
  p: number;
  q: number;
  [key: string]: unknown;
};

/** Makes the provider answer every retrieval with a PAID checkout whose signed
 *  metadata names these listing lines at their signed total, for as long as the
 *  test runs. Extra metadata rides along (a package tag, a thank-you URL). */
export const stubPaidCheckout = (
  sessionId: string,
  items: readonly CheckoutLine[],
  extraMetadata: Record<string, string> = {},
): Promise<Disposable> => {
  const total = items.reduce((sum, item) => sum + item.p * item.q, 0);
  return stubSessionRetrieval(
    paidSession(sessionId, {
      amountTotal: total,
      metadata: signedMeta(
        {
          email: "buyer@example.com",
          items: JSON.stringify(items),
          name: "Payer",
          ...extraMetadata,
        },
        total,
      ),
    }),
  );
};

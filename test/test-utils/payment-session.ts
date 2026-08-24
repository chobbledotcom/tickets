import { isSessionRejection } from "#payment/validated-session.ts";
import type {
  ValidatedPaymentSession,
  WebhookSessionResult,
} from "#shared/payments.ts";
import { webhookMeta } from "#test-utils/factories.ts";

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

import {
  isSessionRejection,
  type SessionRejection,
} from "#shared/payment/validated-session.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";

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

/** Narrow any provider session result to the session; fail the test on a
 *  rejection, a skip, or null. */
export const asSession = (
  result: ValidatedPaymentSession | SessionRejection | "skip" | null,
): ValidatedPaymentSession => {
  if (result === null || result === "skip" || isSessionRejection(result)) {
    throw new Error(`expected a session, got ${JSON.stringify(result)}`);
  }
  return result;
};

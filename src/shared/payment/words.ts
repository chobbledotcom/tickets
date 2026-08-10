import type { PaymentProviderType } from "#shared/types.ts";

/**
 * The words a payment record is allowed to use.
 *
 * Both the tables and the checks the code runs are built from these, so the
 * database and the code can never disagree about what a payment may say.
 * Later milestones add their own vocabularies here (case states, decision
 * states); M4 ships only the words its judge consumes.
 */

/** Whether a payment was real money or a test. */
export const PAYMENT_MODES = ["test", "live"] as const;

/** What each provider calls the money it took. Keyed by provider rather than
 *  lined up beside it, so adding a provider without saying what it calls its
 *  money is a compile error rather than a silently mismatched pair. */
export const RESOURCE_KIND_BY_PROVIDER = {
  square: "square_payment",
  stripe: "stripe_payment_intent",
  sumup: "sumup_transaction",
} as const satisfies Record<PaymentProviderType, string>;

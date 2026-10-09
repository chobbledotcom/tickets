/**
 * The shared checkout-session builder: every provider's create call wrapped in
 * the same error guard, the same shape mapping, and the same answer staging.
 */

import { stageCheckoutAnswers } from "#db/checkout-pending-answers.ts";
import { checkoutFailure } from "#payment/checkout-failure.ts";
import { withCheckoutError } from "#shared/payment-helpers.ts";
import type {
  CheckoutIntent,
  CheckoutSessionResult,
} from "#shared/payments.ts";
import type { PaymentProviderType } from "#types";

type SuccessfulCheckoutResult = Exclude<
  CheckoutSessionResult,
  null | { error: string }
>;

/** Read the created checkout a provider answered with. A checkout the buyer
 * cannot be sent to is an answer we cannot use. It is therefore refused in the
 * words every other unusable provider answer is refused in. */
const createdCheckout = (
  provider: PaymentProviderType,
  sessionId: string | undefined,
  url: string | undefined | null,
): SuccessfulCheckoutResult => {
  if (!sessionId || !url) throw checkoutFailure.invalidResponse(provider);
  return { checkoutUrl: url, sessionId };
};

/**
 * Build a provider's `createCheckoutSession`. Call the provider's own create
 * function, read the session id and URL off whatever shape it returns, and map
 * that to a shared CheckoutSessionResult. All of this runs inside the standard
 * checkout error guard. Each provider only supplies its create call and how to
 * read the id/url. A null create answer means the provider is not configured.
 * A non-null answer must contain both documented fields.
 */
export const makeCreateCheckoutSession =
  <Result>(
    provider: PaymentProviderType,
    create: (intent: CheckoutIntent, baseUrl: string) => Promise<Result | null>,
    readResult: (result: Result) => {
      id: string | undefined;
      /** When the checkout stops taking payment, for a provider whose
       * checkout can outlive the payments clock. */
      linkEndsAt?: string;
      url: string | undefined | null;
    },
  ): ((
    intent: CheckoutIntent,
    baseUrl: string,
  ) => Promise<CheckoutSessionResult>) =>
  (intent, baseUrl) =>
    withCheckoutError(async () => {
      const result = await create(intent, baseUrl);
      if (result === null) return null;
      const { id, linkEndsAt, url } = readResult(result);
      const checkout = createdCheckout(provider, id, url);
      // The session id exists only now, so the answers stage beside it after
      // the provider accepts the checkout. Every provider shares this step,
      // whatever its metadata caps allow the checkout itself to carry.
      await stageCheckoutAnswers(
        checkout.sessionId,
        intent.textAnswers,
        linkEndsAt ?? null,
      );
      return checkout;
    });

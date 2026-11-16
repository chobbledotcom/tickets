import { stub } from "@std/testing/mock";
import type {
  StripeCheckoutSession,
  StripeInvoicePayments,
  StripeSubscription,
} from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import { withMocks } from "#test-utils/mocks.ts";
import {
  stripeCheckoutSession,
  stripeFirstInvoice,
  stripeSubscription,
} from "#test-utils/stripe/fixtures.ts";

/** What Stripe says about a finished subscription checkout: the session the
 * buyer paid, and the subscription it started. */
export type StartedSubscription = {
  invoice?: StripeInvoicePayments;
  session: Partial<StripeCheckoutSession>;
  subscription: Partial<StripeSubscription> & { id: string };
};

/** Run `body` while Stripe answers that `started` was paid and started. The
 * session is in subscription mode, so its charge comes from its first
 * invoice, `in_first`, paid by `pi_first`. */
export const withSubscriptionStarted = (
  started: StartedSubscription,
  body: () => Promise<void>,
): Promise<void> =>
  withMocks(
    () => ({
      invoice: stub(stripeApi, "readInvoicePayments", () =>
        Promise.resolve({
          resource: started.invoice ?? stripeFirstInvoice(),
          status: "found" as const,
        }),
      ),
      read: stub(stripeApi, "readSubscription", () =>
        Promise.resolve({
          resource: stripeSubscription(started.subscription),
          status: "found" as const,
        }),
      ),
      retrieve: stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve(
          stripeCheckoutSession({
            invoice: "in_first",
            mode: "subscription",
            payment_intent: null,
            subscription: started.subscription.id,
            ...started.session,
          }),
        ),
      ),
    }),
    body,
  );

/* jscpd:ignore-start */
import type { BrowserSession } from "#e2e/browser.ts";
import { log } from "#e2e/log.ts";
import { clickFirst, fillFirst } from "./card.ts";
import {
  awaitReturnToApp,
  configureProvider,
  hostedCheckout,
  providerFetch,
  refundObservationVia,
  requiredField,
  saveCredentials,
  testProviderConnection,
} from "./shared.ts";
import type { PaidSandboxCheckout, PaymentProvider } from "./types.ts";

/* jscpd:ignore-end */

/** A Stripe REST call (form-encoded GET/DELETE with the test-mode key). */
const stripeApi = <T>(
  secretKey: string,
  path: string,
  method?: string,
): Promise<T> =>
  providerFetch("stripe", `https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
    ...(method === undefined ? {} : { method }),
  }) as Promise<T>;

/** Ask the owner's "Test Connection" button about Stripe. Beyond the key, it
 * proves the rotation left exactly one of our webhook endpoints behind. */
const testStripeConnection = (session: BrowserSession): Promise<void> => {
  const webhookUrl = `${session.baseUrl}/payment/webhook`;
  return testProviderConnection(session, "stripe", {
    alsoWrong: (text) => {
      const endpoints = text.split(webhookUrl).length - 1;
      return endpoints === 1 ? null : `current endpoint count: ${endpoints}`;
    },
    passed: "Stripe connection, webhook listing, and endpoint rotation passed",
    require: [
      "API Key: Valid (test mode)",
      `${webhookUrl} (tickets)`,
      "Events: checkout.session.completed",
    ],
  });
};

/** The checkout session id embedded in the hosted page's URL (cs_test_…). */
const sessionFromUrl = (url: string): string => {
  const match = url.match(/(cs_test_|cs_live_)[A-Za-z0-9]+/);
  const id = match?.[0];
  if (!id) {
    throw new Error(
      `the Stripe Checkout page URL carries no checkout session id: ${url}`,
    );
  }
  return id;
};

/** The PaymentIntent a paid checkout session names. */
const paymentIntentOf = async (
  secretKey: string,
  checkoutSessionId: string,
): Promise<string> => {
  const session = await stripeApi<{ payment_intent?: string }>(
    secretKey,
    `/v1/checkout/sessions/${encodeURIComponent(checkoutSessionId)}`,
  );
  return requiredField(
    session.payment_intent,
    "stripe",
    `payment_intent on checkout session ${checkoutSessionId}`,
  );
};

type StripeRefund = {
  amount?: number;
  currency?: string;
  status?: string;
};

export const stripe: PaymentProvider = {
  /**
   * Delete all and only the webhook endpoints pointing at THIS scenario's
   * exact webhook URL, walking the list with proper pagination. Exact URL
   * matching also cleans an endpoint left by a configuration step that failed
   * before its id could be recorded, and never touches another consumer's
   * endpoint — unlike the account-wide sweep this replaces. Failures throw:
   * a leaked endpoint fails the scenario.
   */
  cleanup: async (owned, secrets): Promise<void> => {
    const secretKey = secrets.secretKey;
    const exactUrl = `${owned.publicBaseUrl}/payment/webhook`;
    let startingAfter: string | undefined;
    let deleted = 0;
    for (;;) {
      const page = await stripeApi<{
        data?: { id: string; url?: string }[];
        has_more?: boolean;
      }>(
        secretKey,
        `/v1/webhook_endpoints?limit=100${
          startingAfter
            ? `&starting_after=${encodeURIComponent(startingAfter)}`
            : ""
        }`,
      );
      // A 2xx list answer without its documented `data` array is a malformed
      // boundary, not an empty account — it must not pass as "nothing there".
      const endpoints = requiredField(
        page.data,
        "stripe",
        "data on the webhook endpoint list",
      );
      for (const endpoint of endpoints) {
        if (endpoint.url !== exactUrl) continue;
        await stripeApi(
          secretKey,
          `/v1/webhook_endpoints/${endpoint.id}`,
          "DELETE",
        );
        deleted++;
        log(`  deleted this scenario's Stripe webhook endpoint ${endpoint.id}`);
      }
      if (!page.has_more || endpoints.length === 0) break;
      startingAfter = endpoints[endpoints.length - 1]?.id;
    }
    if (deleted === 0) {
      log("  no Stripe webhook endpoints to clean for this URL");
    }
  },

  configure: configureProvider("stripe", async (session, secrets) => {
    // The second save rotates the endpoint through the app's production cleanup
    // path. The connection result then proves only the replacement remains.
    const credentials = { stripe_secret_key: secrets.secretKey };
    await saveCredentials(session, "stripe", credentials);
    await saveCredentials(session, "stripe", credentials);
    await testStripeConnection(session);
  }),
  name: "stripe",

  observeRefund: refundObservationVia(
    "stripe",
    (checkout, secrets) =>
      stripeApi<{ data?: StripeRefund[] }>(
        secrets.secretKey,
        `/v1/refunds?payment_intent=${encodeURIComponent(
          checkout.paymentIntentId,
        )}&limit=100`,
      ),
    (list) => {
      // Same boundary rule as the endpoint list: a missing `data` array is a
      // malformed answer, never "no refunds yet".
      const refunds = requiredField(
        list.data,
        "stripe",
        "data on the refund list",
      );
      // Nothing settled yet would make the sum a lie — report pending.
      const succeeded = refunds.filter(
        (refund) => refund.status === "succeeded",
      );
      if (succeeded.length === 0 || succeeded.length !== refunds.length) {
        return null;
      }
      return {
        amount: succeeded.reduce(
          (sum, refund) =>
            sum +
            requiredField(
              refund.amount,
              "stripe",
              "amount on a succeeded refund",
            ),
          0,
        ),
        currency: succeeded[0]?.currency,
      };
    },
  ),

  payHostedCheckout: hostedCheckout(
    "Filling Stripe Checkout hosted page…",
    async (page, ctx): Promise<PaidSandboxCheckout> => {
      const checkoutSessionId = sessionFromUrl(page.url());
      // Stripe Checkout renders the card fields at the top level with stable ids
      // (#cardNumber/#cardExpiry/#cardCvc/#billingName/#billingPostalCode). Email
      // is prefilled from the booking. US ZIP (42424) to match the account's
      // billing country — a UK postcode gets its letters stripped to a too-short
      // ZIP ("SW1A 1AA" → "11", "incomplete").
      await fillFirst(
        page,
        "card number",
        ["#cardNumber", 'input[name="cardNumber"]'],
        "4242424242424242",
      );
      await fillFirst(
        page,
        "expiry",
        ["#cardExpiry", 'input[name="cardExpiry"]'],
        "12 / 34",
      );
      await fillFirst(
        page,
        "cvc",
        ["#cardCvc", 'input[name="cardCvc"]'],
        "123",
      );
      await fillFirst(
        page,
        "name on card",
        ["#billingName", 'input[name="billingName"]'],
        "E2E Tester",
        { required: false },
      );
      await fillFirst(
        page,
        "postal code",
        ["#billingPostalCode", 'input[name="billingPostalCode"]'],
        "42424",
        { required: false },
      );
      // Stripe pre-checks "Save my information for faster checkout" (Link), which
      // makes the phone number field required — leaving it empty blocks Pay with a
      // "Required" error and the submit button stuck "incomplete". Uncheck it so
      // no phone number is needed.
      const linkOptIn = page
        .locator('#enableStripePass, input[name="enableStripePass"]')
        .first();
      try {
        if (await linkOptIn.isChecked({ timeout: 3_000 })) {
          await linkOptIn.uncheck({ timeout: 5_000 });
          log("  unchecked Link 'save my information' opt-in");
        }
      } catch {
        // opt-in not shown on this variant — nothing to do
      }
      await clickFirst(page, "pay button", [
        'button[data-testid="hosted-payment-submit-button"]',
        ".SubmitButton",
        'button:has-text("Pay")',
      ]);

      // The browser is heading back to the app's return URL (held or real —
      // a held route still commits to that URL).
      const returnUrl = await awaitReturnToApp("stripe", page, ctx.baseUrl);
      const paymentIntentId = await paymentIntentOf(
        ctx.secrets.secretKey,
        checkoutSessionId,
      );
      log(
        `  Stripe checkout ${checkoutSessionId} paid (PaymentIntent ${paymentIntentId})`,
      );
      return {
        checkoutSessionId,
        paymentIntentId,
        provider: "stripe",
        returnUrl,
      };
    },
  ),
  setupCountry: "US",
};

/* jscpd:ignore-start */
import { type BrowserSession, requirePageText } from "../browser.ts";
import { config } from "../config.ts";
import { BOOKER_NAME } from "../flow.ts";
import { log, warn } from "../log.ts";
import { clickFirst, fillFirst } from "./card.ts";
import { configureProvider, hostedCheckout } from "./shared.ts";
import type { PaymentProvider } from "./types.ts";

/* jscpd:ignore-end */

const saveStripeKey = async (
  session: BrowserSession,
  secretKey: string,
): Promise<void> => {
  await session.fill("stripe_secret_key", secretKey);
  await session.clickButton("Update Stripe Key");
};

const testStripeConnection = async (session: BrowserSession): Promise<void> => {
  const button = session.page.locator("#stripe-test-btn");
  const result = session.page.locator("#stripe-test-result");
  await button.click({ force: true, timeout: config.actionTimeoutMs });
  await result.waitFor({ state: "visible", timeout: config.navTimeoutMs });

  const text = await result.innerText();
  const webhookUrl = `${session.baseUrl}/payment/webhook`;
  const missing = [
    "API Key: Valid (test mode)",
    `${webhookUrl} (tickets)`,
    "Events: checkout.session.completed",
  ].filter((expected) => !text.includes(expected));
  const webhookCount = text.split(webhookUrl).length - 1;
  const passed = await result.evaluate((element) =>
    element.classList.contains("success"),
  );
  if (passed && missing.length === 0 && webhookCount === 1) {
    log("  Stripe connection, webhook listing, and endpoint rotation passed");
    return;
  }

  await session.dumpPage("stripe-connection-test-failed");
  throw new Error(
    "Stripe connection test did not confirm one current webhook endpoint. " +
      `Missing: ${missing.join(", ") || "none"}; ` +
      `current endpoint count: ${webhookCount}. Result:\n${text}`,
  );
};

const exerciseStripeRefund = async (session: BrowserSession): Promise<void> => {
  const attendee = session.page.getByRole("link", {
    exact: true,
    name: BOOKER_NAME,
  });
  const attendeeHref = await attendee.getAttribute("href");
  if (!attendeeHref) {
    throw new Error(`Could not open paid attendee "${BOOKER_NAME}"`);
  }
  await session.goto(attendeeHref);

  // This polls the real PaymentIntent with latest_charge expanded.
  await session.clickButton("Refresh payment status");
  await requirePageText(
    session,
    "Payment status is up to date",
    "stripe-payment-status-failed",
    'Expected the app page to contain "Payment status is up to date"',
  );

  await session.clickLink("Actions");
  await session.clickLink("Refund");
  await session.fill("confirm_identifier", BOOKER_NAME);
  await session.clickButton("Refund Attendee");
  await requirePageText(
    session,
    "Refund issued",
    "stripe-refund-failed",
    'Expected the app page to contain "Refund issued"',
  );

  await session.clickLink("Overview");
  const paymentDetails = await session.page
    .locator(".prose", { hasText: "Payment Details" })
    .first()
    .innerText();
  if (
    !paymentDetails.includes("Refund Status:") ||
    !paymentDetails.includes("Refunded")
  ) {
    await session.dumpPage("stripe-refund-not-recorded");
    throw new Error(
      `Stripe refund was not recorded on the attendee. Payment details:\n${paymentDetails}`,
    );
  }
  log("  Stripe PaymentIntent lookup and full refund passed");
};

/**
 * Stripe. Configuring the key registers a webhook endpoint against the site's
 * public HTTPS URL, so this provider REQUIRES the cloudflared tunnel.
 *
 * Hosted Stripe Checkout (checkout.stripe.com) exposes its inputs at the top
 * level (not iframed), addressable via the WHATWG cc-* autocomplete tokens the
 * generic card filler tries first. The billing country shown on Checkout is
 * driven by the Stripe account, so the postal field expects a matching format —
 * a US sandbox account rejects a UK postcode ("your ZIP is incomplete"). Set up
 * the site as US/USD and enter a US ZIP so the two agree.
 * Sandbox test card: 4242 4242 4242 4242, any future expiry, any CVC.
 * Docs: https://docs.stripe.com/testing
 */
export const stripe: PaymentProvider = {
  afterPaidBooking: exerciseStripeRefund,
  // Each run registers a webhook endpoint for its ephemeral *.trycloudflare.com
  // URL, and the throwaway DB forgets the id — so without cleanup they pile up
  // and Stripe eventually rejects new ones (accounts cap webhook endpoints).
  // Delete every endpoint pointing at a trycloudflare tunnel, which also sweeps
  // up any orphans left by earlier runs.
  cleanup: async (secrets): Promise<void> => {
    const headers = { Authorization: `Bearer ${secrets.secretKey}` };
    try {
      const res = await fetch(
        "https://api.stripe.com/v1/webhook_endpoints?limit=100",
        { headers },
      );
      if (!res.ok) {
        warn(`  Stripe webhook cleanup: list failed (HTTP ${res.status})`);
        return;
      }
      const body = (await res.json()) as {
        data?: { id: string; url?: string }[];
      };
      const stale = (body.data ?? []).filter((e) =>
        e.url?.includes("trycloudflare.com"),
      );
      for (const endpoint of stale) {
        await fetch(
          `https://api.stripe.com/v1/webhook_endpoints/${endpoint.id}`,
          { headers, method: "DELETE" },
        ).catch(() => {});
        log(`  deleted stale Stripe webhook endpoint ${endpoint.id}`);
      }
      if (stale.length === 0) {
        log("  no stale Stripe webhook endpoints to clean");
      }
    } catch (err) {
      warn(`  Stripe webhook cleanup skipped: ${String(err)}`);
    }
  },

  configure: configureProvider("stripe", async (session, secrets) => {
    // The second save rotates the endpoint through the app's production cleanup
    // path. The connection result then proves only the replacement remains.
    await saveStripeKey(session, secrets.secretKey);
    await saveStripeKey(session, secrets.secretKey);
    await testStripeConnection(session);
  }),
  firstBookingConfirmation: "webhook",
  name: "stripe",

  payHostedCheckout: hostedCheckout(
    "Filling Stripe Checkout hosted page…",
    async (page) => {
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
    },
  ),
  setupCountry: "US",
};

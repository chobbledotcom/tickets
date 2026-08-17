import type { Page } from "playwright";
import { log } from "#e2e/log.ts";
import { squareRequestInit } from "#shared/square/transport.ts";
import {
  configureProvider,
  hostedCheckout,
  noProviderCleanup,
  type ProviderRequest,
  providerFetch,
  readLoggedId,
  refundObservationVia,
  requiredField,
} from "./shared.ts";
import type {
  HostedCheckoutContext,
  PaidSandboxCheckout,
  PaymentProvider,
} from "./types.ts";

/**
 * Square. Payment confirmation is asserted via the browser return URL
 * (validatePaidSession → processPaymentSession). Square webhooks require a
 * signed subscription created manually in the dashboard against a fixed
 * notification URL, which can't be provisioned for an ephemeral tunnel — so
 * this leg does NOT exercise Square's webhook path; confirmation is the return
 * URL only.
 *
 * WHY THIS LEG COMPLETES THE PAYMENT VIA THE API, NOT THE BROWSER
 * ---------------------------------------------------------------
 * Unlike Stripe and SumUp, Square's SANDBOX has no browser-drivable hosted card
 * page. A sandbox payment link (CreatePaymentLink → long_url) redirects to
 * Square's "Checkout API Sandbox Testing Panel"
 * (connect.squareupsandbox.com/.../sandbox-testing-panel/…). That panel only
 * ever exposes Next / "Test Payment" / "Preview Link" / "Preview Checkout"
 * controls; the buyer "Preview Link" (sandbox.square.link/u/…) just redirects
 * back to the panel, and nothing there completes the order or redirects to the
 * app with an orderId. (This was proven by dumping every interactive element on
 * every step across a full walk — there is simply no card entry in sandbox.)
 *
 * Square documents that sandbox payments are completed via the Payments API
 * using a test card nonce, so this is exactly how a real integration is tested.
 * We therefore drive the *whole app journey* in the browser as a customer
 * (setup → listing → booking → redirect to Square), then complete the payment
 * the way Square's sandbox supports — CreatePayment(cnon:card-nonce-ok) against
 * the order the app created — and finally drive the browser to the app's real
 * return URL (/payment/success?orderId=…). The app then runs its genuine
 * return-handling: retrieveOrder → the order now has a COMPLETED tender → the
 * session is "paid" → the booking is created and the income ledger is recorded.
 * Only Square's non-existent hosted card UI is bypassed; every line of the
 * app's payment path is exercised.
 *
 * The sandbox API base is the only one this driver knows: there is no
 * production mode knob to leave enabled by mistake.
 */

const SQUARE_SANDBOX_API = "https://connect.squareupsandbox.com";

// Square's universal sandbox "successful Visa" card nonce. Completing a payment
// with this against the order marks it COMPLETED with a card tender.
// Docs: https://developer.squareup.com/docs/devtools/sandbox/payments
const SANDBOX_CARD_NONCE = "cnon:card-nonce-ok";

type SquareMoney = { amount: number; currency: string };

/** Options for a single Square REST call. */
type SquareRequest = { method?: string; body?: unknown };

/** The Square order id the app logs when it creates a payment link. */
const readOrderId = (logPath: string): Promise<string> =>
  readLoggedId(
    logPath,
    /\[Square\] Payment link created orderId=(\S+)/g,
    "[Square] Payment link created orderId=…",
  );

/** Authenticated Square sandbox REST call; throws with the API body on a
 * non-2xx. */
const squareFetch = (
  token: string,
  path: string,
  init?: SquareRequest,
): Promise<unknown> =>
  providerFetch(
    "square",
    `${SQUARE_SANDBOX_API}${path}`,
    squareRequestInit(token, init) as ProviderRequest,
  );

/**
 * Complete the Square sandbox payment for the order the app created, then send
 * the browser to the app's real return URL so the app confirms and books it.
 * Returns the exact order/payment identity this scenario owns.
 */
const completeViaSandboxApi = async (
  page: Page,
  ctx: HostedCheckoutContext,
): Promise<PaidSandboxCheckout> => {
  const token = ctx.secrets.token;

  const orderId = await readOrderId(ctx.serverLogPath);
  log(
    `Square sandbox has no hosted card page; completing order ${orderId} via the Payments API…`,
  );

  // Read the order back to pay the exact amount/currency it was created for
  // (matching the app's signed total — a mismatch would be refused).
  const orderResp = (await squareFetch(
    token,
    `/v2/orders/${encodeURIComponent(orderId)}`,
  )) as {
    order?: {
      location_id?: string;
      version?: number;
      state?: string;
      total_money?: SquareMoney;
      net_amount_due_money?: SquareMoney;
    };
  };
  const order = orderResp.order;
  const amountMoney = order?.net_amount_due_money ?? order?.total_money;
  const locationId = requiredField(
    order?.location_id ?? ctx.secrets.locationId,
    "square",
    `location_id on order ${orderId}`,
  );
  if (!amountMoney) {
    throw new Error(
      `Square: order ${orderId} missing total (got ${JSON.stringify(order)})`,
    );
  }
  log(
    `  order total ${amountMoney.amount} ${amountMoney.currency} @ location ${locationId} (state=${order?.state})`,
  );

  // A payment link creates its order in DRAFT state, but a payment can only be
  // taken against an OPEN order ("The order must be OPEN to be paid" → the
  // authorised payment is otherwise voided). Transition DRAFT → OPEN first.
  if (order?.state && order.state !== "OPEN") {
    await squareFetch(token, `/v2/orders/${encodeURIComponent(orderId)}`, {
      body: {
        idempotency_key: crypto.randomUUID(),
        order: {
          location_id: locationId,
          state: "OPEN",
          version: order.version,
        },
      },
      method: "PUT",
    });
    log(`  transitioned order ${orderId} ${order.state} → OPEN`);
  }

  // CreatePayment with the sandbox test nonce, linked to the order and
  // auto-completed → the order gains a COMPLETED card tender, which is exactly
  // what the app's retrieveSession treats as "paid".
  const payResp = (await squareFetch(token, "/v2/payments", {
    body: {
      amount_money: amountMoney,
      autocomplete: true,
      idempotency_key: crypto.randomUUID(),
      location_id: locationId,
      order_id: orderId,
      source_id: SANDBOX_CARD_NONCE,
    },
    method: "POST",
  })) as { payment?: { id?: string; status?: string } };
  const paymentId = requiredField(
    payResp.payment?.id,
    "square",
    `payment id for order ${orderId}`,
  );
  log(`  payment ${paymentId} status=${payResp.payment?.status}`);
  if (payResp.payment?.status !== "COMPLETED") {
    throw new Error(
      `Square: sandbox payment did not complete (status=${payResp.payment?.status})`,
    );
  }

  // Drive the browser to the app's real return URL, exactly as Square would on
  // a live redirect (the app reads orderId → validates the now-paid order).
  const returnUrl = `${ctx.baseUrl}/payment/success?orderId=${encodeURIComponent(
    orderId,
  )}`;
  log(`  navigating the browser to the app return URL: ${returnUrl}`);
  await page.goto(returnUrl, { waitUntil: "domcontentloaded" });
  return { orderId, paymentId, provider: "square", returnUrl };
};

export const square: PaymentProvider = {
  // Sandbox payments and refunds are append-only resources; Square has no
  // ephemeral webhook endpoint for this harness to remove.
  cleanup: noProviderCleanup,
  configure: configureProvider("square", async (session, secrets) => {
    await session.fill("square_access_token", secrets.token);
    await session.fill("square_location_id", secrets.locationId);
    // The sandbox checkbox is the only mode this harness can drive.
    await session.check("square_sandbox");
    await session.clickButton("Update Square Credentials");
  }),
  name: "square",

  observeRefund: refundObservationVia(
    "square",
    (checkout, secrets) =>
      squareFetch(
        secrets.token,
        `/v2/payments/${encodeURIComponent(checkout.paymentId)}`,
      ) as Promise<{ payment?: { refunded_money?: SquareMoney } }>,
    (payment) => {
      const refunded = payment.payment?.refunded_money;
      // A refund call that has not landed yet reports nothing returned.
      if (!refunded || refunded.amount <= 0) return null;
      return { amount: refunded.amount, currency: refunded.currency };
    },
  ),

  payHostedCheckout: hostedCheckout(
    "Completing Square sandbox payment…",
    completeViaSandboxApi,
  ),
  // The Square sandbox account/location has a FIXED currency and rejects a
  // payment link whose amount is in any other currency ("This business can only
  // process payments in GBP but amount was provided in USD"). This sandbox is
  // GBP, so set the site up as GB. Override with SETUP_COUNTRY to match a
  // differently-configured Square sandbox location.
  setupCountry: "GB",
};

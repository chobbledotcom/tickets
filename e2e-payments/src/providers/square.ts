import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import type { BrowserSession } from "../browser.ts";
import { log } from "../log.ts";
import { assertConfigured, selectProvider } from "./shared.ts";
import type { HostedCheckoutContext, PaymentProvider } from "./types.ts";

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
 * session is "paid" → the booking is created and the income ledger is recorded,
 * all asserted by assertPaidBookingConfirmed. Only Square's non-existent hosted
 * card UI is bypassed; every line of the app's payment path is exercised.
 */

const SQUARE_API = {
  sandbox: "https://connect.squareupsandbox.com",
  production: "https://connect.squareup.com",
} as const;

// Match the app's Square-Version so request/response shapes agree.
const SQUARE_API_VERSION = "2025-01-23";

// Square's universal sandbox "successful Visa" card nonce. Completing a payment
// with this against the order marks it COMPLETED with a card tender.
// Docs: https://developer.squareup.com/docs/devtools/sandbox/payments
const SANDBOX_CARD_NONCE = "cnon:card-nonce-ok";

type SquareMoney = { amount: number; currency: string };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Recover the Square order id the app created for this booking from its server
 * log (it is logged as `[Square] Payment link created orderId=…`). Polled
 * briefly because the log write and our read race the redirect. */
const readOrderId = async (logPath: string): Promise<string> => {
  const deadline = Date.now() + 10_000;
  const pattern = /\[Square\] Payment link created orderId=(\S+)/g;
  let last: string | null = null;
  while (Date.now() < deadline) {
    let text = "";
    try {
      text = readFileSync(logPath, "utf8");
    } catch {
      // log not flushed yet
    }
    for (const m of text.matchAll(pattern)) last = m[1] ?? last;
    if (last) return last;
    await sleep(300);
  }
  throw new Error(
    `Square: could not find the created orderId in the app server log (${logPath}). ` +
      "Expected a '[Square] Payment link created orderId=…' line.",
  );
};

/** Authenticated Square REST call; throws with the API body on a non-2xx. */
const squareFetch = async (
  base: string,
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> => {
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Square-Version": SQUARE_API_VERSION,
    },
    ...(init?.body != null ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Square API ${path} → HTTP ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
};

/**
 * Complete the Square sandbox payment for the order the app created, then send
 * the browser to the app's real return URL so the app confirms and books it.
 */
const completeViaSandboxApi = async (
  page: Page,
  ctx: HostedCheckoutContext,
): Promise<void> => {
  const sandbox = ctx.secrets.sandbox === "true";
  const base = sandbox ? SQUARE_API.sandbox : SQUARE_API.production;
  const token = ctx.secrets.token;

  const orderId = await readOrderId(ctx.serverLogPath);
  log(`Square sandbox has no hosted card page; completing order ${orderId} via the Payments API…`);

  // Read the order back to pay the exact amount/currency it was created for
  // (matching the app's signed total — a mismatch would be refused).
  const orderResp = (await squareFetch(
    base,
    token,
    `/v2/orders/${encodeURIComponent(orderId)}`,
  )) as {
    order?: { location_id?: string; total_money?: SquareMoney; net_amount_due_money?: SquareMoney };
  };
  const order = orderResp.order;
  const amountMoney = order?.net_amount_due_money ?? order?.total_money;
  const locationId = order?.location_id ?? ctx.secrets.locationId;
  if (!amountMoney || !locationId) {
    throw new Error(
      `Square: order ${orderId} missing total/location (got ${JSON.stringify(order)})`,
    );
  }
  log(`  order total ${amountMoney.amount} ${amountMoney.currency} @ location ${locationId}`);

  // CreatePayment with the sandbox test nonce, linked to the order and
  // auto-completed → the order gains a COMPLETED card tender, which is exactly
  // what the app's retrieveSession treats as "paid".
  const payResp = (await squareFetch(base, token, "/v2/payments", {
    method: "POST",
    body: {
      source_id: SANDBOX_CARD_NONCE,
      idempotency_key: crypto.randomUUID(),
      amount_money: amountMoney,
      order_id: orderId,
      location_id: locationId,
      autocomplete: true,
    },
  })) as { payment?: { id?: string; status?: string } };
  log(`  payment ${payResp.payment?.id} status=${payResp.payment?.status}`);
  if (payResp.payment?.status !== "COMPLETED") {
    throw new Error(
      `Square: sandbox payment did not complete (status=${payResp.payment?.status})`,
    );
  }

  // Drive the browser to the app's real return URL, exactly as Square would on
  // a live redirect (the app reads orderId → validates the now-paid order).
  const returnUrl = `${ctx.baseUrl}/payment/success?orderId=${encodeURIComponent(orderId)}`;
  log(`  navigating the browser to the app return URL: ${returnUrl}`);
  await page.goto(returnUrl, { waitUntil: "domcontentloaded" });
};

export const square: PaymentProvider = {
  name: "square",
  // The Square sandbox account/location has a FIXED currency and rejects a
  // payment link whose amount is in any other currency ("This business can only
  // process payments in GBP but amount was provided in USD"). This sandbox is
  // GBP, so set the site up as GB. Override with SETUP_COUNTRY to match a
  // differently-configured Square sandbox location.
  setupCountry: "GB",

  configure: async (session: BrowserSession, secrets): Promise<void> => {
    await selectProvider(session, "square");
    await session.fill("square_access_token", secrets.token);
    await session.fill("square_location_id", secrets.locationId);
    if (secrets.sandbox === "true") await session.check("square_sandbox");
    await session.clickButton("Update Square Credentials");
    await assertConfigured(session, "square");
  },

  payHostedCheckout: async (
    page: Page,
    ctx: HostedCheckoutContext,
  ): Promise<void> => {
    await page.waitForLoadState("domcontentloaded");
    await completeViaSandboxApi(page, ctx);
  },
};

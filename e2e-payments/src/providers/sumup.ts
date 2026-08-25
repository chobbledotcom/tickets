/* jscpd:ignore-start */
import type { Locator, Page } from "playwright";
import type { BrowserSession } from "#e2e/browser.ts";
import { log, warn } from "#e2e/log.ts";
import { clickFirst, fillCard, fillFirst, fillFrameInput } from "./card.ts";
import { type AfterPayOutcome, watchAfterPay } from "./post-pay.ts";
import {
  awaitReturnToApp,
  configureProvider,
  hostedCheckout,
  noProviderCleanup,
  providerFetch,
  readLoggedId,
  refundObservationVia,
  requiredField,
  testProviderConnection,
} from "./shared.ts";
import type { PaidSandboxCheckout, PaymentProvider } from "./types.ts";

/* jscpd:ignore-end */

/**
 * SumUp. Sandbox vs live is inferred from the API key itself, and no webhook
 * signature is required (the app re-fetches the checkout to confirm). Payment
 * confirmation flows through the browser return URL; the callback path is
 * then exercised deterministically by self-delivering the staged checkout's
 * own callback (see sumup-callback.ts).
 *
 * SumUp's hosted checkout (checkout.sumup.com) renders its card inputs with
 * Braintree hosted fields: each field is a separate cross-origin iframe titled
 * "Secure Credit Card Frame - <field>", holding a single <input>. We target
 * those iframes by title and fill the lone input inside. If SumUp serves a
 * non-Braintree variant, fall back to the generic same-frame card filler.
 * Sandbox test card: 4200 0000 0000 0091 (approved, frictionless 3DS), any
 * future expiry, any CVV. Docs:
 * https://developer.sumup.com/online-payments/tools/test-cards
 */

// SumUp sandbox Visa that succeeds with frictionless (no 3DS challenge)
// authentication. 4000…0002 is a DECLINE card ("Payment Declined").
// Docs: https://developer.sumup.com/online-payments/testing
const CARD = {
  cvc: "123",
  expiry: "12/34",
  name: "E2E Tester",
  number: "4200000000000091",
} as const;

const SUMUP_API_BASE = "https://api.sumup.com";

/** The id line createCheckout logs once the staged row carries the SumUp id. */
const SUMUP_ID_LINE = {
  expected: "[SumUp] Checkout created id=…",
  pattern: "\\[SumUp\\] Checkout created id=(\\S+)",
} as const;

/** Authenticated SumUp REST call; throws with the status on a non-2xx. */
const sumupFetch = (apiKey: string, path: string): Promise<unknown> =>
  providerFetch("sumup", `${SUMUP_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

/** One SumUp transaction's refund events, as the history API returns them. */
type SumupTransactionBody = {
  currency?: string;
  transaction_events?: {
    amount?: number;
    currency?: string;
    event_type?: string;
    status?: string;
  }[];
};

/** The SumUp checkout id for THIS scenario, recovered at the narrow creation
 * boundary: the database (and its log) are fresh, so the one logged id is the
 * one this scenario's booking created. It immediately becomes typed state. */
const checkoutIdFor = (logPath: string): Promise<string> =>
  readLoggedId(logPath, SUMUP_ID_LINE.pattern, SUMUP_ID_LINE.expected);

/** The transaction id a paid SumUp checkout names — the refund/payment
 * reference the app (and this harness's refund observation) uses. */
const transactionIdOf = async (
  apiKey: string,
  checkoutId: string,
): Promise<string> => {
  const checkout = (await sumupFetch(
    apiKey,
    `/v0.1/checkouts/${encodeURIComponent(checkoutId)}`,
  )) as {
    status?: string;
    transaction_id?: string;
    transactions?: { id?: string }[];
  };
  const transactionId =
    checkout.transaction_id ?? checkout.transactions?.[0]?.id;
  return requiredField(
    transactionId,
    "sumup",
    `transaction id on checkout ${checkoutId}`,
  );
};

/**
 * Ask the owner's "Test Connection" button about SumUp.
 *
 * This is the only journey that asks SumUp for the merchant behind the key, so
 * it is the only proof that the merchant read works against the real API. The
 * merchant line appears only when that read succeeded, so asserting the real
 * merchant code proves the call and not just the page.
 */
const testSumupConnection = (
  session: BrowserSession,
  merchantCode: string,
): Promise<void> =>
  testProviderConnection(session, "sumup", {
    passed: "SumUp connection and merchant lookup passed",
    require: ["API Key: Valid", `Merchant: ${merchantCode}`],
  });

export const sumup: PaymentProvider = {
  // SumUp sets its return URL per checkout and registers no webhook endpoint;
  // payments and refunds are append-only sandbox resources.
  cleanup: noProviderCleanup,
  configure: configureProvider("sumup", async (session, secrets) => {
    await session.fill("sumup_api_key", secrets.apiKey);
    await session.fill("sumup_merchant_code", secrets.merchantCode);
    await session.clickButton("Update SumUp Credentials");
    await testSumupConnection(session, secrets.merchantCode);
  }),
  name: "sumup",

  observeRefund: refundObservationVia(
    "sumup",
    (checkout, secrets) =>
      sumupFetch(
        secrets.apiKey,
        `/v2.1/merchants/${encodeURIComponent(
          secrets.merchantCode,
        )}/transactions?id=${encodeURIComponent(checkout.transactionId)}`,
      ) as Promise<SumupTransactionBody>,
    (transaction) => {
      const refundEvents = (transaction.transaction_events ?? []).filter(
        (event) => event.event_type === "REFUND",
      );
      if (refundEvents.length === 0) return null;
      // A FAILED refund never returned money — report it as the failure it
      // is, never as a pending or completed observation.
      if (refundEvents.some((event) => event.status === "FAILED")) {
        throw new Error(
          "sumup's refund event reports FAILED — the refund did not succeed",
        );
      }
      // Only money whose event status proves it was paid out counts as
      // returned — the same mapping production applies
      // (src/shared/sumup/money.ts): REFUNDED/SUCCESSFUL completed,
      // PENDING/SCHEDULED still settling. Settling events report nothing
      // yet, so the observation stays honestly pending.
      const settledEvents = refundEvents.filter(
        (event) => event.status === "REFUNDED" || event.status === "SUCCESSFUL",
      );
      if (settledEvents.length === 0) return null;
      // SumUp's history reports money in MAJOR units (1.37); the shared
      // observation carries minor units like every other provider. The
      // harness only runs 2-decimal currencies (GBP/USD — the documented
      // setup assumption), so a fixed hundredfold conversion is exact.
      const toMinor = (major: number): number => Math.round(major * 100);
      return {
        amount: settledEvents.reduce(
          (sum, event) =>
            sum +
            toMinor(
              requiredField(
                event.amount,
                "sumup",
                "amount on a settled REFUND transaction event",
              ),
            ),
          0,
        ),
        // SumUp does not reliably repeat the currency on every REFUND event;
        // the transaction's own currency carries it (production reads it the
        // same way — src/shared/sumup/transaction.ts).
        currency:
          refundEvents.find((event) => event.currency)?.currency ??
          transaction.currency,
      };
    },
  ),

  payHostedCheckout: hostedCheckout(
    "Filling SumUp hosted checkout…",
    async (page, ctx): Promise<PaidSandboxCheckout> => {
      // Braintree hosted fields: each card field is its own iframe titled
      // "Secure Credit Card Frame - <field>", holding a single <input>.
      const usedBraintree = await fillFrameInput(
        page,
        "card number",
        ["Card Number", "Credit Card Number"],
        "input",
        CARD.number,
        10_000,
      );

      if (usedBraintree) {
        // Once the card-number Braintree iframe is present, expiry and CVV are
        // REQUIRED to submit. If either can't be filled (its iframe title changed,
        // or it loaded late), fail fast here with the specific missing field —
        // otherwise Pay is clicked with an incomplete card and the run dies as a
        // misleading checkout/confirmation timeout that hides the real cause.
        const filledExpiry = await fillFrameInput(
          page,
          "expiry",
          ["Expiration"],
          "input",
          CARD.expiry,
        );
        const filledCvc = await fillFrameInput(
          page,
          "cvc",
          ["CVV", "CVC"],
          "input",
          CARD.cvc,
        );
        if (!filledExpiry || !filledCvc) {
          const missing = [
            ...(filledExpiry ? [] : ["expiry"]),
            ...(filledCvc ? [] : ["cvc"]),
          ].join(" and ");
          throw new Error(
            `SumUp: filled the Braintree card number but could not fill the ${missing} ` +
              "hosted field(s) — the iframe title likely changed. Refusing to submit an " +
              "incomplete card.",
          );
        }
        // Cardholder name is required on SumUp's page and renders slightly after
        // the hosted card fields, so poll for it (across the top level and any
        // frame) rather than a one-shot presence check — otherwise Pay is blocked
        // by "Please enter the cardholder name" and the booking never redirects.
        await fillFirst(
          page,
          "cardholder name",
          [
            'input[name="card-holder-name"]',
            'input[name="cardHolder"]',
            'input[autocomplete="cc-name"]',
            'input[id*="cardholder" i]',
            'input[placeholder*="name" i]',
            'input[aria-label*="name" i]',
          ],
          CARD.name,
        );
      } else {
        warn("  Braintree hosted fields not found — trying generic card fill");
        await fillCard(page, {
          cvc: CARD.cvc,
          expiry: CARD.expiry,
          name: CARD.name,
          number: CARD.number,
        });
      }

      await clickFirst(page, "pay button", [
        '[data-testid="widget-pay-button"]',
        'button[data-testid*="pay" i]',
        'button:has-text("Pay")',
        'button[type="submit"]',
      ]);

      await returnToMerchant(page);

      // The browser is back on the app's return URL; capture the exact URL
      // and this checkout's exact SumUp ids before anything else happens.
      const returnUrl = await awaitReturnToApp("sumup", page, ctx.baseUrl);
      const checkoutId = await checkoutIdFor(ctx.serverLogPath);
      const transactionId = await transactionIdOf(
        ctx.secrets.apiKey,
        checkoutId,
      );
      log(`  SumUp checkout ${checkoutId} paid (transaction ${transactionId})`);
      return { checkoutId, provider: "sumup", returnUrl, transactionId };
    },
  ),
  setupCountry: "GB",
};

/** Is this locator visible right now? A probe that lands mid-navigation or on
 * a detached node reads as "not visible yet", and the caller's loop asks
 * again. A closed page can never answer later, so that fault propagates. */
const visibleNow = async (target: Locator): Promise<boolean> => {
  try {
    return await target.isVisible();
  } catch (error) {
    if (target.page().isClosed()) throw error;
    return false;
  }
};

/** Click the control when it is visible. False when it is absent, or when the
 * click lost a race with a navigation, so the loop asks again. */
const clickIfVisible = async (link: Locator): Promise<boolean> => {
  if (!(await visibleNow(link))) return false;
  try {
    await link.click({ timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
};

/** How long the harness watches the paid page for a way home. */
const RETURN_WATCH_MS = 30_000;

/** What each watch outcome does. "declined" fails at once with the true cause
 * instead of a missing-return-URL timeout two minutes later. */
const AFTER_PAY_ACTIONS: Record<AfterPayOutcome, () => void> = {
  clicked_back: () =>
    log("  clicked SumUp's 'Back to merchant website' to return to the app"),
  declined: () => {
    throw new Error(
      'SumUp\'s hosted checkout says "Payment Declined" — the sandbox refused the payment, ' +
        "so the browser can never return to the app. The harness sent the approved test " +
        "card. If the charged total is a documented decline amount (11.00, 42.01, 42.76, " +
        "42.91), this run configured the decline. Any other total means a SumUp-side fault.",
    );
  },
  // Already redirected home — nothing to click and nothing to report.
  left_provider: () => undefined,
  timed_out: () =>
    warn(
      "  SumUp: no 'Back to merchant website' button appeared after paying — " +
        "relying on an auto-redirect that may not happen.",
    ),
};

/**
 * SumUp's sandbox checkout does NOT auto-redirect after a successful payment: it
 * parks on a "Payment successful" confirmation page (still on checkout.sumup.com)
 * with a "Back to merchant website" button the customer must click to return to
 * the app's return URL. Click it so the browser heads home — without it the run
 * stalls on the SumUp page and dies as a misleading "did not land on a success
 * page" timeout even though the payment (and its webhook) already succeeded.
 *
 * A refused payment parks here too, on a "Payment Declined" banner whose only
 * button is "Try Again", so no return home can ever come.
 *
 * The loop itself is `watchAfterPay` (post-pay.ts), which holds the order and
 * the cadence under direct tests. This wrapper owns only the SumUp locators
 * and what each outcome does. A timeout stays best-effort and non-fatal: if a
 * future SumUp variant auto-redirects, the caller's return-URL wait confirms
 * the landing.
 */
const returnToMerchant = async (page: Page): Promise<void> => {
  const namePattern = /back to merchant|return to merchant|merchant website/i;
  const link = page
    .getByRole("link", { name: namePattern })
    .or(page.getByRole("button", { name: namePattern }))
    .first();
  // The visible headline of SumUp's decline page. Its other occurrence sits in
  // a script-tag i18n bundle, which text matching never reads.
  const declined = page.getByText(/payment declined/i).first();

  // SumUp serves its hosted checkout from more than one host — the docs return
  // checkout.sumup.com, but pay.sumup.com is also used (the app's CSP allows
  // both). Match any *.sumup.com origin so a pay.sumup.com checkout still gets
  // the "Back to merchant website" click rather than being mistaken for a
  // redirect that already happened.
  const onSumUp = (): boolean => {
    try {
      return new URL(page.url()).hostname.endsWith(".sumup.com");
    } catch {
      return false;
    }
  };

  const outcome = await watchAfterPay(
    {
      clickBack: () => clickIfVisible(link),
      declineVisible: () => visibleNow(declined),
      onProvider: onSumUp,
    },
    { now: Date.now, wait: (ms) => page.waitForTimeout(ms) },
    RETURN_WATCH_MS,
  );
  AFTER_PAY_ACTIONS[outcome]();
};

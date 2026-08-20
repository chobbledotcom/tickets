/* jscpd:ignore-start */
import type { Page } from "playwright";
import { log, warn } from "#e2e/log.ts";
import { clickFirst, fillCard, fillFirst, fillFrameInput } from "./card.ts";
import {
  awaitReturnToApp,
  configureProvider,
  hostedCheckout,
  noProviderCleanup,
  providerFetch,
  readLoggedId,
  refundObservationVia,
  requiredField,
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

export const sumup: PaymentProvider = {
  // SumUp sets its return URL per checkout and registers no webhook endpoint;
  // payments and refunds are append-only sandbox resources.
  cleanup: noProviderCleanup,
  configure: configureProvider("sumup", async (session, secrets) => {
    await session.fill("sumup_api_key", secrets.apiKey);
    await session.fill("sumup_merchant_code", secrets.merchantCode);
    await session.clickButton("Update SumUp Credentials");
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

/**
 * SumUp's sandbox checkout does NOT auto-redirect after a successful payment: it
 * parks on a "Payment successful" confirmation page (still on checkout.sumup.com)
 * with a "Back to merchant website" button the customer must click to return to
 * the app's return URL. Click it so the browser heads home — without it the run
 * stalls on the SumUp page and dies as a misleading "did not land on a success
 * page" timeout even though the payment (and its webhook) already succeeded.
 *
 * Best-effort and non-fatal: if a future SumUp variant auto-redirects, the
 * button never appears (or the browser has already left the SumUp origin) and we
 * simply return, letting the caller's return-URL wait confirm the landing.
 */
const returnToMerchant = async (page: Page): Promise<void> => {
  const namePattern = /back to merchant|return to merchant|merchant website/i;
  const link = page
    .getByRole("link", { name: namePattern })
    .or(page.getByRole("button", { name: namePattern }))
    .first();

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

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // Already redirected away from SumUp's checkout — nothing to click.
    if (!onSumUp()) return;
    try {
      if (await link.isVisible({ timeout: 500 })) {
        await link.click({ timeout: 5_000 });
        log(
          "  clicked SumUp's 'Back to merchant website' to return to the app",
        );
        return;
      }
    } catch {
      // Page navigating or the node detached mid-check; re-evaluate next loop.
    }
    await page.waitForTimeout(500);
  }
  warn(
    "  SumUp: no 'Back to merchant website' button appeared after paying — " +
      "relying on an auto-redirect that may not happen.",
  );
};

/**
 * Browser contract for the SumUp decline wiring in sumup.ts: the "Payment
 * Declined" locator and the declined action that throws. The wait loop's
 * policy has direct tests in test/e2e-payments/providers/post-pay.test.ts;
 * this contract proves the Playwright half against a real page, without a
 * provider sandbox.
 *
 * The canned page is shaped like the decline the nightly captured in run
 * 32807391290: Braintree-titled card iframes, a cardholder input, the widget
 * pay button, and — after Pay — the "Payment Declined" banner in place of
 * the form. It is served on a checkout.sumup.com URL through request
 * interception, so the origin check keeps the wait loop alive.
 *
 * The whole journey runs through `sumup.payHostedCheckout`, so nothing is
 * exported for the test alone. The decline throws before the context is
 * read, so the context carries unreachable stand-ins.
 *
 * Runs under `deno task test:screenshot-contract` (Chromium required),
 * never in the main suite or the nightly harness.
 */

import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import { type Browser, chromium, type Page } from "playwright";
import { config } from "#e2e/config.ts";
import { sumup } from "#e2e/providers/sumup.ts";
import { browserLaunchOptions } from "#scripts/browser-options.ts";

const DECLINE_URL = "https://checkout.sumup.com/pay/canned-decline";

const CANNED_CHECKOUT = `<!doctype html>
<title>Checkout for Chobble Sandbox</title>
<div id="form">
  <iframe title="Secure Credit Card Frame - Credit Card Number" srcdoc="<input>"></iframe>
  <iframe title="Secure Credit Card Frame - Expiration Date" srcdoc="<input>"></iframe>
  <iframe title="Secure Credit Card Frame - CVV" srcdoc="<input>"></iframe>
  <input autocomplete="cc-name">
  <button data-testid="widget-pay-button" type="button">Pay</button>
</div>
<div id="declined" hidden>
  <h2><span>Payment Declined</span></h2>
  <p>Please try again</p>
  <button type="button">Try Again</button>
</div>
<script>
  document
    .querySelector('[data-testid="widget-pay-button"]')
    .addEventListener("click", () => {
      document.getElementById("form").hidden = true;
      document.getElementById("declined").hidden = false;
    });
</script>`;

/** Open the canned checkout on the SumUp origin and hand the page over. */
const withCannedCheckout = async <T>(
  browser: Browser,
  run: (page: Page) => Promise<T>,
): Promise<T> => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) =>
      route.fulfill({ body: CANNED_CHECKOUT, contentType: "text/html" }),
    );
    await page.goto(DECLINE_URL);
    return await run(page);
  } finally {
    await page.close();
  }
};

describe("SumUp decline banner browser contract", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch(
      browserLaunchOptions(true, config.chromiumExecutable),
    );
  });

  afterAll(async () => {
    await browser.close();
  });

  test("fails at once with the true cause when the page declines", async () => {
    await withCannedCheckout(browser, async (page) => {
      const startedAt = Date.now();
      const paying = sumup.payHostedCheckout(page, {
        baseUrl: "http://127.0.0.1:1",
        secrets: {},
        serverLogPath: "unreached-by-the-decline-path.log",
      });

      await expect(paying).rejects.toThrow(/says "Payment Declined"/);
      // Well inside the 30-second watch window: the point is "at once",
      // not another timeout.
      expect(Date.now() - startedAt).toBeLessThan(10_000);
    });
  });
});

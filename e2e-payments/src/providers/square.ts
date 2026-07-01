import type { Page } from "playwright";
import type { BrowserSession } from "../browser.ts";
import { log } from "../log.ts";
import { clickFirst, fillCard } from "./card.ts";
import { assertConfigured, selectProvider } from "./shared.ts";
import type { PaymentProvider } from "./types.ts";

/** Log every button/link on the page and its frames (text + key attributes),
 * so a CI failure reveals exactly what controls a hosted page offers. */
const dumpControls = async (page: Page): Promise<void> => {
  for (const root of [page, ...page.frames()]) {
    try {
      const controls = await root
        .locator('button, a, [role="button"], input[type="submit"]')
        .evaluateAll((els) =>
          els.slice(0, 40).map((el) => {
            const h = el as HTMLElement;
            const attr = (n: string) => h.getAttribute(n) ?? "";
            return {
              tag: h.tagName.toLowerCase(),
              text: (h.innerText || (h as HTMLInputElement).value || "")
                .trim()
                .slice(0, 60),
              testid: attr("data-testid"),
              id: h.id,
            };
          }),
        );
      for (const c of controls.filter((c) => c.text || c.testid || c.id)) {
        log(
          `    control: <${c.tag}> "${c.text}"${c.testid ? ` testid=${c.testid}` : ""}${c.id ? ` id=${c.id}` : ""}`,
        );
      }
    } catch {
      // frame detached; skip
    }
  }
};

/**
 * Square SANDBOX payment links redirect to a "sandbox testing panel" (host
 * connect.squareupsandbox.com, path /online-checkout/sandbox-testing-panel/…),
 * not a real card-entry page: you simulate the buyer by clicking a button. Log
 * the panel's controls (so any change is visible in CI) and click the control
 * that completes the payment.
 */
const completeSandboxPanel = async (page: Page): Promise<void> => {
  log("Square sandbox testing panel detected; completing test payment…");
  // The panel is a React app that renders its form asynchronously, so wait for
  // it to settle and for the primary button to appear before clicking. Its
  // completion control is labelled "Test Payment" (per Square's sandbox docs);
  // keep a few fallbacks in case the label changes.
  await page.waitForLoadState("networkidle").catch(() => {});
  const payButton = page
    .locator(
      [
        'button:has-text("Test Payment")',
        'button:has-text("Pay")',
        'button:has-text("Complete")',
        'button:has-text("Submit")',
        'button[type="submit"]',
      ].join(", "),
    )
    .first();
  try {
    await payButton.waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    // Button never appeared — dump what the panel does offer so CI shows it.
    await dumpControls(page);
    throw new Error(
      "Square sandbox testing panel: no 'Test Payment' (or equivalent) button appeared",
    );
  }
  await payButton.click();
  log("  clicked the sandbox panel's payment button");
};

/**
 * Square. Payment confirmation is asserted via the browser return URL
 * (validatePaidSession → processPaymentSession). Square webhooks require a
 * signed subscription created manually in the dashboard against a fixed
 * notification URL, which can't be provisioned for an ephemeral tunnel — so
 * this leg does NOT exercise Square's webhook path (the app rejects unsigned
 * Square webhooks). Scope is the return path only; see README.
 *
 * Square's hosted checkout renders card inputs inside the Web Payments SDK
 * iframe, so the card-fill helper searches child frames too.
 * Sandbox test card: 4111 1111 1111 1111, any future expiry, CVV 111,
 * postal 94103. Docs: https://developer.squareup.com/docs/devtools/sandbox/payments
 */
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

  payHostedCheckout: async (page: Page): Promise<void> => {
    await page.waitForLoadState("domcontentloaded");
    // In sandbox, payment links land on the testing panel (button-driven), not a
    // card form. Handle that; otherwise fall back to real card entry.
    if (page.url().includes("sandbox-testing-panel")) {
      await completeSandboxPanel(page);
      return;
    }
    log("Filling Square hosted checkout…");
    // Square's card inputs live inside the Web Payments SDK iframe; the generic
    // filler searches child frames and matches the SDK's cc-* autocomplete
    // tokens. Sandbox card 4111 …, CVV 111, postal 94103.
    await fillCard(page, {
      number: "4111111111111111",
      expiry: "12/34",
      cvc: "111",
      postal: "94103",
    });
    await clickFirst(page, "pay button", [
      'button:has-text("Pay")',
      'button[type="submit"]',
      "#rswp-card-button",
    ]);
  },
};

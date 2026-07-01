import type { Page } from "playwright";
import type { BrowserSession } from "../browser.ts";
import { log, warn } from "../log.ts";
import { assertConfigured, selectProvider } from "./shared.ts";
import type { PaymentProvider } from "./types.ts";

/**
 * Square. Payment confirmation is asserted via the browser return URL
 * (validatePaidSession → processPaymentSession). Square webhooks require a
 * signed subscription created manually in the dashboard against a fixed
 * notification URL, which can't be provisioned for an ephemeral tunnel — so
 * this leg does NOT exercise Square's webhook path; confirmation is the return
 * URL only.
 *
 * Square SANDBOX payment links (CreatePaymentLink → long_url) redirect to
 * Square's "Checkout API Sandbox Testing Panel"
 * (connect.squareupsandbox.com/.../sandbox-testing-panel/…). In sandbox there
 * is no separate buyer card page — the panel's "Preview Link"
 * (sandbox.square.link/u/…) just redirects back here — so the panel IS the
 * checkout: it *simulates* accepting the payment via a stepper (Overview →
 * Test Payment → Checkout → Complete) driven by real <button> controls
 * ("Next", then a completion button). Walking that stepper marks the order
 * paid and redirects to the app's return URL.
 */

/** Log the real buttons on the panel (text), so CI shows each step's controls. */
const describeButtons = async (page: Page): Promise<void> => {
  for (const root of [page, ...page.frames()]) {
    try {
      const texts = await root
        .getByRole("button")
        .allInnerTexts()
        .catch(() => [] as string[]);
      const labels = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
      if (labels.length) log(`    buttons: ${labels.join(" | ")}`);
    } catch {
      // frame detached
    }
  }
};

/** Click the first visible real button (any frame) whose accessible name
 * matches, and return whether one was clicked. */
const clickButtonByName = async (
  page: Page,
  name: RegExp,
): Promise<boolean> => {
  for (const root of [page, ...page.frames()]) {
    const btn = root.getByRole("button", { name }).first();
    try {
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click({ timeout: 5_000 });
        log(`  clicked button /${name.source}/`);
        return true;
      }
    } catch {
      // not present / not clickable here
    }
  }
  return false;
};

/**
 * Walk the sandbox testing panel's stepper to completion. On each step prefer
 * the most "final" action available (Complete/Pay/Charge/Simulate) and fall
 * back to Next/Continue to advance; re-describe the buttons each round. Stop as
 * soon as the browser leaves the panel for the app's return URL (which
 * assertPaidBookingConfirmed then checks).
 */
const completeSandboxPanel = async (page: Page): Promise<void> => {
  log("Square sandbox testing panel detected; walking the stepper…");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1_500);

  for (let round = 0; round < 10; round++) {
    if (!page.url().includes("sandbox-testing-panel")) {
      log(`  left the testing panel → ${page.url()}`);
      return;
    }
    await describeButtons(page);
    // Prefer the most "final" action, then fall back to advancing the wizard.
    // The sandbox panel's steps are: Overview ("Next") → a step whose primary
    // action is literally "Test Payment" (this simulates the buyer paying) →
    // completion, which redirects to the app return URL. "Test Payment" is a
    // real <button> here (getByRole), not the step-label span that getByText
    // used to trap on, so it's safe to click by accessible name.
    const advanced =
      (await clickButtonByName(
        page,
        /test payment|complete|finish|charge|simulate|approve|succeed|^pay\b/i,
      )) ||
      (await clickButtonByName(
        page,
        /^next$|continue|confirm|submit|^done$|^ok$|close/i,
      ));
    if (!advanced) {
      warn("  no advance/complete button found on this step");
      break;
    }
    await page.waitForTimeout(2_000);
    log(`  now at ${page.url()}`);
  }
  if (page.url().includes("sandbox-testing-panel")) {
    throw new Error(
      "Square: walked the sandbox testing panel stepper but never left it " +
        "(see the described buttons above to tighten the sequence)",
    );
  }
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

  payHostedCheckout: async (page: Page): Promise<void> => {
    await page.waitForLoadState("domcontentloaded");
    await completeSandboxPanel(page);
  },
};

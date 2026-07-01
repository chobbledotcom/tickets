import type { Page } from "playwright";
import type { BrowserSession } from "../browser.ts";
import { log, warn } from "../log.ts";
import { clickFirst, fillCard } from "./card.ts";
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
 * (connect.squareupsandbox.com/.../sandbox-testing-panel/…): a React stepper
 * with a "Next" button and a "Preview Link" to the real buyer checkout
 * (sandbox.square.link/u/…). We open that buyer checkout and pay with a
 * sandbox card, which redirects back to the app's return URL.
 * Sandbox test card: 4111 1111 1111 1111, any future expiry, CVV 111.
 * Docs: https://developer.squareup.com/docs/devtools/sandbox/payments
 */

/** The real buyer checkout is linked from the panel as sandbox.square.link/u/…
 * Grab that URL so we can drive an actual card payment instead of the panel. */
const findBuyerCheckoutUrl = async (page: Page): Promise<string | null> => {
  for (const root of [page, ...page.frames()]) {
    const href = await root
      .locator('a[href*="square.link/u/"]')
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (href) return href;
  }
  return null;
};

/** Log every input/iframe on the page and its frames (with the attributes that
 * identify a card field) so CI reveals the buyer checkout's real structure. */
const describeInputs = async (page: Page): Promise<void> => {
  log(`    buyer checkout has ${page.frames().length} frame(s)`);
  for (const root of [page, ...page.frames()]) {
    const url = "url" in root ? root.url() : page.url();
    try {
      const fields = (await root
        .locator('input, iframe, [role="textbox"], [contenteditable]')
        .evaluateAll((els) =>
          els.slice(0, 30).map((el) => {
            const h = el as HTMLElement;
            const a = (n: string) => h.getAttribute(n) || "";
            return {
              tag: h.tagName.toLowerCase(),
              type: a("type"),
              name: a("name"),
              id: h.id,
              ph: a("placeholder"),
              ac: a("autocomplete"),
              al: a("aria-label"),
              title: a("title"),
            };
          }),
        )) as {
        tag: string;
        type: string;
        name: string;
        id: string;
        ph: string;
        ac: string;
        al: string;
        title: string;
      }[];
      for (const f of fields) {
        log(
          `      <${f.tag}> type=${f.type} name=${f.name} id=${f.id} ` +
            `ph="${f.ph}" ac=${f.ac} al="${f.al}" title="${f.title}" @ ${url.slice(0, 48)}`,
        );
      }
    } catch {
      // cross-origin frame not readable; skip
    }
  }
};

/** Fill the Square-hosted buyer checkout's card form and pay. */
const payBuyerCheckout = async (page: Page): Promise<void> => {
  log(`Filling Square hosted buyer checkout (${page.url()})…`);
  // Give the Web Payments SDK iframe time to mount, then describe the fields so
  // CI shows exactly how the card inputs are structured.
  await page.waitForTimeout(3_000);
  await describeInputs(page);
  // Square renders card inputs inside the Web Payments SDK iframe; the generic
  // filler searches child frames. Sandbox card 4111 …, CVV 111.
  await fillCard(page, {
    number: "4111111111111111",
    expiry: "12/34",
    cvc: "111",
    postal: "94103",
  });
  await clickFirst(page, "pay button", [
    "#rswp-card-button",
    'button:has-text("Pay")',
    'button[type="submit"]',
  ]);
};

/**
 * The sandbox payment link lands on Square's testing panel. Open the buyer
 * checkout it links to (the real hosted card page) and pay there. Falls back to
 * walking the panel's "Next" stepper if no buyer link is present.
 */
const completeSandboxPanel = async (page: Page): Promise<void> => {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1_000);

  const buyerUrl = await findBuyerCheckoutUrl(page);
  if (buyerUrl) {
    log(`Square testing panel → opening buyer checkout: ${buyerUrl}`);
    await page.goto(buyerUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_000);
    await payBuyerCheckout(page);
    return;
  }

  // Fallback: no buyer link found — try to advance the panel's stepper. The
  // "Next" button advances it; keep clicking until we leave the panel.
  warn("  no sandbox.square.link buyer URL found; walking the panel stepper");
  for (let i = 0; i < 8 && page.url().includes("sandbox-testing-panel"); i++) {
    const next = page.getByRole("button", { name: /next|complete|pay|done/i }).first();
    if (!(await next.isVisible({ timeout: 1_000 }).catch(() => false))) break;
    await next.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
  }
  if (page.url().includes("sandbox-testing-panel")) {
    throw new Error(
      "Square: could not reach a payable checkout from the sandbox testing panel",
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

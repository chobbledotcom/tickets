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

/** The interactive-element roles we both describe and try to click, so a
 * control that turns out to be a link/menuitem (not a <button>) is still seen
 * and driven — e.g. "Test Payment" opens a menu of test scenarios. */
const CLICK_ROLES = ["button", "menuitem", "option", "link", "tab"] as const;

const onPanel = (page: Page): boolean =>
  page.url().includes("sandbox-testing-panel");

/**
 * Dump every interactive element on the panel (across all frames) with its
 * tag/role/type, accessible-ish name, and visible/disabled state. This is the
 * "describe the elements available" diagnostic: it shows exactly which controls
 * each step exposes — including menu items a button reveals — so the walk can be
 * driven precisely from the CI log instead of clicking blindly.
 */
const describeInteractive = async (page: Page): Promise<void> => {
  const selector = [
    "button",
    "[role=button]",
    "a[href]",
    "[role=link]",
    "[role=menuitem]",
    "[role=option]",
    "[role=tab]",
    "[role=radio]",
    "input:not([type=hidden])",
    "select",
  ].join(",");
  for (const frame of page.frames()) {
    let rows: string[] = [];
    try {
      rows = await frame.locator(selector).evaluateAll((els) =>
        els.slice(0, 50).map((el) => {
          const e = el as HTMLElement;
          const tag = e.tagName.toLowerCase();
          const role = e.getAttribute("role");
          const type = e.getAttribute("type");
          const name = (
            e.getAttribute("aria-label") ||
            (e as HTMLInputElement).value ||
            e.innerText ||
            e.getAttribute("placeholder") ||
            ""
          )
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 50);
          const s = getComputedStyle(e);
          const visible =
            s.display !== "none" &&
            s.visibility !== "hidden" &&
            (e.offsetWidth > 0 || e.offsetHeight > 0);
          const disabled =
            (e as HTMLButtonElement).disabled === true ||
            e.getAttribute("aria-disabled") === "true";
          return (
            `${tag}` +
            (role ? `[role=${role}]` : "") +
            (type ? `[type=${type}]` : "") +
            ` "${name}"` +
            (visible ? "" : " (hidden)") +
            (disabled ? " (disabled)" : "")
          );
        }),
      );
    } catch {
      // frame detached mid-scrape; skip
    }
    if (rows.length) {
      const where = frame === page.mainFrame() ? "main" : frame.url();
      log(`    [${where}] interactive elements:`);
      for (const r of rows) log(`      · ${r}`);
    }
  }
};

/**
 * Click the first visible, enabled element (any frame, any of CLICK_ROLES)
 * whose accessible name matches. Returns what was clicked, or null.
 */
const clickByName = async (
  page: Page,
  name: RegExp,
): Promise<string | null> => {
  for (const frame of page.frames()) {
    for (const role of CLICK_ROLES) {
      const el = frame.getByRole(role, { name }).first();
      try {
        if (await el.isVisible({ timeout: 250 })) {
          await el.click({ timeout: 5_000 });
          const label = `${role} /${name.source}/`;
          log(`  clicked ${label}`);
          return label;
        }
      } catch {
        // not present / not actionable in this frame; try the next
      }
    }
  }
  return null;
};

/** Poll for the browser leaving the panel (redirect to the app return URL). */
const waitToLeavePanel = async (page: Page, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!onPanel(page)) return true;
    await page.waitForTimeout(500);
  }
  return !onPanel(page);
};

/**
 * Walk the sandbox testing panel's stepper to completion. Each round: describe
 * every interactive element, then click the most "final" action available
 * (Test Payment / a success scenario / Complete), falling back to advancing the
 * wizard (Next/Continue). After every click, wait patiently for the panel to
 * finish and redirect — the payment simulation takes a few seconds — before
 * re-describing (which surfaces any menu the click opened). Stop as soon as the
 * browser leaves the panel for the app's return URL.
 */
const completeSandboxPanel = async (page: Page): Promise<void> => {
  log("Square sandbox testing panel detected; walking the stepper…");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1_500);

  for (let round = 0; round < 12; round++) {
    if (!onPanel(page)) {
      log(`  left the testing panel → ${page.url()}`);
      return;
    }
    log(`  --- step ${round} @ ${page.url()} ---`);
    await describeInteractive(page);

    // Prefer a payment/completion action; a "Test Payment" control may open a
    // menu of scenarios, so the completion set also matches the success ones.
    const clicked =
      (await clickByName(
        page,
        /test payment|complete payment|complete|finish|charge|simulate|approve|success|succeed|paid|^pay\b/i,
      )) ??
      (await clickByName(
        page,
        /^next$|continue|confirm|submit|^done$|^ok$|close/i,
      ));

    if (!clicked) {
      warn("  no clickable advance/complete control found on this step");
      break;
    }
    // Give the click time to process and (hopefully) redirect before looking
    // again; if it merely opened a menu, the next round re-describes it.
    if (await waitToLeavePanel(page, 8_000)) {
      log(`  left the testing panel → ${page.url()}`);
      return;
    }
  }
  if (onPanel(page)) {
    throw new Error(
      "Square: walked the sandbox testing panel stepper but never left it " +
        "(see the described interactive elements above to tighten the sequence)",
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

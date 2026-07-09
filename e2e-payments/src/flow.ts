/**
 * App-level journey, driven through a real browser exactly as a customer would:
 * first-run setup → admin login → create a priced listing → open its public
 * booking page → book → (paid) hosted checkout → land on the return URL →
 * confirm the booking is recorded as paid.
 */

import type { BrowserSession } from "./browser.ts";
import { config } from "./config.ts";
import { log, step } from "./log.ts";

const LISTING_NAME = "E2E Payment Concert";
// Not example.com: some processors (Square) reject that reserved domain as an
// invalid email before redirecting, failing the booking pre-checkout.
const BOOKER_EMAIL = config.bookerEmail;
const BOOKER_NAME = "E2E Booker";
const LOGIN_FIELDS_SELECTOR = '[name="username"], [name="password"]';

/** Run the first-run setup wizard for a fresh install. */
export const runSetup = async (
  session: BrowserSession,
  country: string,
): Promise<void> => {
  step("Running first-run setup");
  await session.goto("/setup/");
  await session.fill("admin_username", config.adminUsername);
  await session.fill("admin_password", config.adminPassword);
  await session.fill("admin_password_confirm", config.adminPassword);
  await session.select("country", country);
  await session.check("accept_agreement");
  await session.clickButton("Complete Setup");
  log(`  setup complete (admin=${config.adminUsername}, country=${country})`);
};

/** Log in to the admin dashboard. */
export const login = async (session: BrowserSession): Promise<void> => {
  step("Logging in");
  await session.goto("/admin/");
  const body = await session.bodyText();
  if (/log ?in/i.test(body)) {
    await session.fill("username", config.adminUsername);
    await session.fill("password", config.adminPassword);
    await session.clickButton("Login");
  }
  // A just-migrated install may show an interstitial.
  if ((await session.bodyText()).includes("Migration complete")) {
    await session.clickLink("Back to dashboard");
  }
  try {
    await session.page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 0,
      LOGIN_FIELDS_SELECTOR,
      { timeout: config.actionTimeoutMs },
    );
  } catch (err) {
    await session.dumpPage("login-did-not-stick");
    throw new Error("admin login did not stick; still on the login page", {
      cause: err,
    });
  }
  log("  logged in");
};

/**
 * Create a listing that collects an email and (when priced > 0) requires
 * payment. Returns the public `/ticket/<slug>` path for booking.
 */
export const createListing = async (
  session: BrowserSession,
  { priceMinor, name = LISTING_NAME }: { priceMinor: number; name?: string },
): Promise<string> => {
  step(`Creating listing "${name}" (price=${priceMinor} minor units)`);
  await session.goto("/admin/listing/new?template=custom");
  await session.fill("name", name);
  await session.fill("description", "End-to-end payment test listing");
  await session.fill("max_attendees", "100");
  await session.fill("max_quantity", "5");
  await session.check("fields", "email");
  // The price field is entered in major units (e.g. "1.00"), not minor.
  await session.fill("unit_price", (priceMinor / 100).toFixed(2));
  await session.clickButton("Create Listing");

  // Open the new listing and read its public booking link.
  await session.goto("/admin/");
  await session.clickLink(name);
  const href = await session.page
    .locator('a[href*="/ticket/"]')
    .first()
    .getAttribute("href", { timeout: config.navTimeoutMs });
  if (!href) {
    throw new Error("no public /ticket/ link found on the listing page");
  }
  const path = href.startsWith("http") ? new URL(href).pathname : href;
  log(`  public booking path: ${path}`);
  return path;
};

/** Wait for the browser to come back onto an app page whose URL or body
 * matches `success` (a hosted checkout hands control back via the return
 * URL). Throws with a page dump when the deadline passes. */
export const waitForAppReturn = async (
  session: BrowserSession,
  success: RegExp,
  dumpLabel: string,
): Promise<void> => {
  const { page } = session;
  const deadline = Date.now() + config.paymentConfirmTimeoutMs;
  while (Date.now() < deadline) {
    const here = page.url().startsWith(session.baseUrl);
    if (here && success.test(page.url() + (await session.bodyText()))) return;
    await page.waitForTimeout(1_000);
  }
  await session.dumpPage(dumpLabel);
  throw new Error(
    `did not land on a page matching ${success} (at ${page.url()})`,
  );
};

/** The listing income ledger's text on the CURRENT admin listing page, or
 * null when no income was recognised (the section does not render). */
export const incomeLedgerText = async (
  session: BrowserSession,
): Promise<string | null> => {
  const ledger = session.page.locator("#income-ledger");
  return (await ledger.count()) === 0 ? null : await ledger.innerText();
};

/**
 * Fill and submit the public booking form. For a free listing this lands on the
 * app's thank-you page; for a paid listing the browser is redirected to the
 * provider's hosted checkout (a different origin).
 */
export const submitBooking = async (
  session: BrowserSession,
  ticketPath: string,
): Promise<void> => {
  step("Submitting booking");
  await session.goto(ticketPath);
  const { page } = session;

  await fillIfPresent(session, "email", BOOKER_EMAIL);
  await fillIfPresent(session, "name", BOOKER_NAME);

  // Quantity field name varies (single `quantity` vs per-listing `quantity_<id>`).
  const qty = page
    .locator('input[name^="quantity"], select[name^="quantity"]')
    .first();
  if (await qty.count()) {
    const tag = await qty.evaluate((el) => el.tagName.toLowerCase());
    if (tag === "select") await qty.selectOption("1");
    else await qty.fill("1");
  }

  const submit = page
    .getByRole("button", { name: /continue|book|pay|checkout|reserve/i })
    .first();
  await session.submitLocator(submit);
  log(`  booking submitted; now at ${page.url()}`);
};

const fillIfPresent = async (
  session: BrowserSession,
  name: string,
  value: string,
): Promise<void> => {
  const loc = session.page.locator(`[name="${name}"]`).first();
  if (await loc.count()) await loc.fill(value);
};

/**
 * Before filling a hosted checkout, assert the booking actually left the app
 * for the provider. If payment-session creation fails server-side the app
 * re-renders the booking page with an error alert (no redirect), and blindly
 * hunting for card fields there just times out with a misleading message. Fail
 * fast with the app's own error instead.
 */
export const assertRedirectedToCheckout = async (
  session: BrowserSession,
): Promise<void> => {
  const { page } = session;
  if (!page.url().startsWith(session.baseUrl)) return; // left for the provider
  const alert = page.locator('.error, [role="alert"]').first();
  const detail = (await alert.count())
    ? (await alert.innerText()).trim()
    : "(no error alert on the page)";
  await session.dumpPage("no-redirect-to-checkout");
  throw new Error(
    `booking did not redirect to the hosted checkout — still on ${page.url()}. ` +
      `The app failed to create the payment session. App said: "${detail}". ` +
      "See the app server log tail above for the provider API error.",
  );
};

/** Assert the free-booking thank-you page was reached. */
export const assertFreeThankYou = async (
  session: BrowserSession,
): Promise<void> => {
  const body = await session.bodyText();
  if (!/thank you|your order|your ticket/i.test(body)) {
    await session.screenshot("free-booking-no-thankyou");
    throw new Error(`expected a thank-you page, got:\n${body.slice(0, 800)}`);
  }
  log("  ✔ free booking reached the thank-you page");
};

/**
 * Scrape any visible error/notification text off a hosted checkout page (the
 * main frame and its payment iframes). Hosted pages surface the real reason a
 * payment stalled — "Your card number is incomplete", "Payment declined" — in
 * small alert/notification nodes that are drowned out by the page's country
 * <select>, so target likely error containers and keyword hits directly.
 */
const collectHostedErrors = async (
  session: BrowserSession,
): Promise<string> => {
  const { page } = session;
  const selector = [
    '[role="alert"]',
    ".error",
    '[class*="error" i]',
    '[class*="invalid" i]',
    '[class*="Notification" i]',
    '[class*="Message" i]',
  ].join(", ");
  const seen = new Set<string>();
  for (const root of [page, ...page.frames()]) {
    try {
      const texts = await root.locator(selector).allInnerTexts();
      for (const t of texts) {
        const clean = t.trim().replace(/\s+/g, " ");
        if (clean && clean.length < 200) seen.add(clean);
      }
    } catch {
      // frame detached mid-scrape; skip
    }
  }
  return [...seen].join(" | ");
};

/**
 * After returning from a hosted checkout, confirm the booking is recorded as
 * paid: the customer sees a success/ticket page, and the admin listing shows
 * the booker with a captured amount.
 */
export const assertPaidBookingConfirmed = async (
  session: BrowserSession,
  _ticketPath: string,
): Promise<void> => {
  step("Confirming the paid booking");
  const { page } = session;

  // 1. Wait for the browser to arrive back on the app's return URL. On a
  // timeout, scrape the hosted checkout's own inline errors — the page body
  // is mostly a huge country <select> that buries the real message.
  try {
    await waitForAppReturn(
      session,
      /payment\/success|\/t\/|thank you|your ticket|payment (received|successful)/i,
      "paid-return-page",
    );
  } catch {
    const hostedError = await collectHostedErrors(session);
    const appBody = await session.bodyText();
    throw new Error(
      `did not land on a success page after checkout.\nURL: ${page.url()}\n` +
        // Prefer the scraped inline error; only fall back to the raw body when
        // no error node was found (the body is mostly a huge country <select>
        // that buries the real message and floods the CI log).
        (hostedError
          ? `Checkout page error(s): ${hostedError}`
          : appBody.slice(0, 400)),
    );
  }
  log(`  ✔ customer saw the success page (${page.url()})`);

  // 2. Cross-check in admin: the listing's Overview tab shows the captured
  // income, and its Attendees tab shows the booker — the listing detail page
  // was split into tabs (Overview / Attendees / …), so the roster no longer
  // renders inline on the tab reached by clicking the listing name.
  await session.goto("/admin/");
  await login(session);
  await session.clickLink(LISTING_NAME);

  // …crucially, that the payment was actually captured. Assert against the
  // listing's INCOME LEDGER specifically — it projects from the payment ledger,
  // so a regression that creates the attendee but drops the payment
  // (price_paid = 0) records no income and the ledger section does not render.
  // Do NOT fall back to scanning the whole page: the listing detail also shows
  // the configured ticket price, which would give a false pass with no payment.
  const paidRegion = await incomeLedgerText(session);
  if (paidRegion === null) {
    await session.screenshot("paid-admin-no-income-ledger");
    throw new Error(
      "the listing's income ledger (#income-ledger) did not render — no recognised " +
        "income was recorded for the paid booking (lost/failed payment?)",
    );
  }

  // Match the app's rendering: formatCurrency uses `trailingZeroDisplay:
  // "stripIfInteger"`, so a whole amount renders "£1" (no decimals) while a
  // non-round amount keeps them ("£1.37"). This assumes a 2-decimal currency —
  // the provider defaults (GBP/USD/EUR via SETUP_COUNTRY) are all 2-decimal;
  // zero-decimal currencies (e.g. JPY) are unsupported, as the price entry
  // itself would need currency-aware decimals. The digits match regardless of
  // the symbol; accept both the decimal and stripped-whole forms so an
  // E2E_UNIT_PRICE override to a whole amount still matches.
  const withDecimals = (config.unitPrice / 100).toFixed(2); // "1.37" / "2.00"
  const strippedWhole = withDecimals.replace(/\.00$/, ""); //  "1.37" / "2"
  if (
    !paidRegion.includes(withDecimals) &&
    !paidRegion.includes(strippedWhole)
  ) {
    await session.screenshot("paid-admin-no-income");
    throw new Error(
      `captured payment not reflected in the listing's income ledger (expected ${withDecimals}). ` +
        `Income ledger:\n${paidRegion.slice(0, 600)}`,
    );
  }

  // 3. The booker itself appears on the Attendees tab, not the Overview tab
  // just checked above. Scoped to the tab strip (`nav.entity-tabs`): the
  // global admin nav also has an "Attendees" link (the site-wide
  // `/admin/attendees` index), and clickLink's unscoped `.first()` would match
  // that link — landing on the wrong page and passing without ever exercising
  // this listing's tab.
  const attendeesTabLink = session.page
    .locator("nav.entity-tabs a", { hasText: "Attendees" })
    .first();
  const attendeesHref = await attendeesTabLink.getAttribute("href", {
    timeout: config.navTimeoutMs,
  });
  if (!attendeesHref) {
    throw new Error("no Attendees tab link found on the listing page");
  }
  await session.goto(attendeesHref);
  const attendeesBody = await session.bodyText();
  if (!attendeesBody.includes(BOOKER_EMAIL)) {
    await session.screenshot("paid-admin-missing-booker");
    throw new Error(
      `paid booker ${BOOKER_EMAIL} not visible on the admin listing's Attendees tab`,
    );
  }

  log(
    `  ✔ admin listing shows the paid booker (${BOOKER_EMAIL}) and captured amount (${withDecimals})`,
  );
};

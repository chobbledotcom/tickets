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
const BOOKER_EMAIL = "e2e-booker@example.com";
const BOOKER_NAME = "E2E Booker";

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
  log("  logged in");
};

/**
 * Create a listing that collects an email and (when priced > 0) requires
 * payment. Returns the public `/ticket/<slug>` path for booking.
 */
export const createListing = async (
  session: BrowserSession,
  { priceMinor }: { priceMinor: number },
): Promise<string> => {
  step(`Creating listing (price=${priceMinor} minor units)`);
  await session.goto("/admin/listing/new?template=custom");
  await session.fill("name", LISTING_NAME);
  await session.fill("description", "End-to-end payment test listing");
  await session.fill("max_attendees", "100");
  await session.fill("max_quantity", "5");
  await session.check("fields", "email");
  // The price field is entered in major units (e.g. "1.00"), not minor.
  await session.fill("unit_price", (priceMinor / 100).toFixed(2));
  await session.clickButton("Create Listing");

  // Open the new listing and read its public booking link.
  await session.goto("/admin/");
  await session.clickLink(LISTING_NAME);
  const href = await session.page
    .locator('a[href*="/ticket/"]')
    .first()
    .getAttribute("href", { timeout: config.navTimeoutMs });
  if (!href) throw new Error("no public /ticket/ link found on the listing page");
  const path = href.startsWith("http") ? new URL(href).pathname : href;
  log(`  public booking path: ${path}`);
  return path;
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
  const qty = page.locator('input[name^="quantity"], select[name^="quantity"]').first();
  if (await qty.count()) {
    const tag = await qty.evaluate((el) => el.tagName.toLowerCase());
    if (tag === "select") await qty.selectOption("1");
    else await qty.fill("1");
  }

  const submit = page
    .getByRole("button", { name: /continue|book|pay|checkout|reserve/i })
    .first();
  await submit.click();
  await page.waitForLoadState("domcontentloaded");
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
 * After returning from a hosted checkout, confirm the booking is recorded as
 * paid: the customer sees a success/ticket page, and the admin listing shows
 * the booker with a captured amount.
 */
export const assertPaidBookingConfirmed = async (
  session: BrowserSession,
  ticketPath: string,
): Promise<void> => {
  step("Confirming the paid booking");
  const { page } = session;

  // 1. Wait for the browser to arrive back on the app's return URL.
  const deadline = Date.now() + config.paymentConfirmTimeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.startsWith(session.baseUrl) && /payment\/success|\/t\/|thank/i.test(url + (await session.bodyText()))) {
      break;
    }
    await page.waitForTimeout(1_000);
  }
  const successBody = await session.bodyText();
  if (!/thank you|your ticket|payment (received|successful)|success/i.test(successBody)) {
    await session.screenshot("paid-return-page");
    throw new Error(
      `did not land on a success page after checkout.\nURL: ${page.url()}\n${successBody.slice(0, 800)}`,
    );
  }
  log(`  ✔ customer saw the success page (${page.url()})`);

  // 2. Cross-check in admin: the booker appears on the listing…
  await session.goto("/admin/");
  await login(session);
  await session.clickLink(LISTING_NAME);
  const adminBody = await session.bodyText();
  if (!adminBody.includes(BOOKER_EMAIL)) {
    await session.screenshot("paid-admin-missing-booker");
    throw new Error(
      `paid booker ${BOOKER_EMAIL} not visible on the admin listing page`,
    );
  }

  // …and, crucially, that the payment was actually captured. Assert against the
  // listing's INCOME LEDGER specifically — it projects from the payment ledger,
  // so a regression that creates the attendee but drops the payment
  // (price_paid = 0) records no income and the ledger section does not render.
  // Do NOT fall back to scanning the whole page: the listing detail also shows
  // the configured ticket price, which would give a false pass with no payment.
  const ledger = session.page.locator("#income-ledger");
  if ((await ledger.count()) === 0) {
    await session.screenshot("paid-admin-no-income-ledger");
    throw new Error(
      "the listing's income ledger (#income-ledger) did not render — no recognised " +
        "income was recorded for the paid booking (lost/failed payment?)",
    );
  }
  const paidRegion = await ledger.innerText();

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
  log(
    `  ✔ admin listing shows the paid booker (${BOOKER_EMAIL}) and captured amount (${withDecimals})`,
  );
};

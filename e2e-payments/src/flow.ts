/**
 * App-level journey, driven through a real browser exactly as a customer would:
 * first-run setup → admin login → create a priced listing → open its public
 * booking page → book → (paid) hosted checkout → land on the return URL →
 * confirm the booking is recorded as paid. Every value that must be unique to
 * one scenario (owner credentials, booker identity, listing name) is passed in
 * by the caller rather than shared globally.
 */

/* jscpd:ignore-start */
import type { Locator } from "playwright";
import { type BrowserSession, hrefOf, requirePageText } from "./browser.ts";
import { catalogWords } from "./catalog-words.ts";
import {
  type BookerIdentity,
  config,
  type OwnerCredentials,
} from "./config.ts";
import { log, step } from "./log.ts";
import { pollUntil } from "./util.ts";

/* jscpd:ignore-end */

const LOGIN_FIELDS_SELECTOR = '[name="username"], [name="password"]';

/** Who the booking belongs to, for admin-side assertions. */
export interface BookingIdentity {
  booker: BookerIdentity;
  listingName: string;
  priceMinor: number;
}

/** Run the first-run setup wizard for a fresh install. */
export const runSetup = async (
  session: BrowserSession,
  country: string,
  owner: OwnerCredentials,
): Promise<void> => {
  step("Running first-run setup");
  await session.goto("/setup/");
  await session.fill("admin_username", owner.username);
  await session.fill("admin_password", owner.password);
  await session.fill("admin_password_confirm", owner.password);
  await session.select("country", country);
  await session.check("accept_agreement");
  await session.clickButton(await catalogWords("setup", "setup.submit"));
  log(`  setup complete (admin=${owner.username}, country=${country})`);
};

/** Log in to the admin dashboard. */
export const login = async (
  session: BrowserSession,
  owner: OwnerCredentials,
): Promise<void> => {
  step("Logging in");
  await session.goto("/admin/");
  const body = await session.bodyText();
  // The login page's own heading names it, so a copy rename travels with
  // the spec instead of stranding the driver off a stale regex.
  if (body.includes(await catalogWords("login", "login.title"))) {
    await session.fill("username", owner.username);
    await session.fill("password", owner.password);
    await session.clickButton(await catalogWords("login", "login.submit"));
  }
  // A just-migrated install may show an interstitial.
  if ((await session.bodyText()).includes("Migration complete")) {
    await session.clickLink(
      await catalogWords("seed-data", "admin.seeds.back"),
    );
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
  { priceMinor, name }: { name: string; priceMinor: number },
): Promise<string> => {
  step(`Creating listing "${name}" (price=${priceMinor} minor units)`);
  await session.goto("/admin/listing/new?template=custom");
  await session.fill("name", name);
  // The description is a rich markdown editor whose backing textarea is
  // hidden — type into the visible editing surface like a person.
  await session.typeInto(
    ".md-editor .ProseMirror",
    "End-to-end payment test listing",
  );
  await session.fill("max_attendees", "100");
  await session.fill("max_quantity", "5");
  await session.check("fields", "email");
  // The price field is entered in major units (e.g. "1.00"), not minor.
  await session.fill("unit_price", (priceMinor / 100).toFixed(2));
  await session.clickButton(
    await catalogWords("listings-table", "listings_table.create_listing"),
  );

  // Open the new listing and read its public booking link.
  await session.goto("/admin/");
  await session.clickLink(name);
  const href = await hrefOf(
    session.page.locator('a[href*="/ticket/"]').first(),
    "no public /ticket/ link found on the listing page",
  );
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
  const returned = await pollUntil(config.paymentConfirmTimeoutMs, async () => {
    const here = page.url().startsWith(session.baseUrl);
    return here && success.test(page.url() + (await session.bodyText()))
      ? true
      : null;
  });
  if (returned) return;
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

/** The income ledger's own label for what a listing earned before refunds. */
const TOTAL_INCOME_EARNED = "Total income earned";

/**
 * What the ledger's "Total income earned" row reports, in minor units, or
 * null when the ledger carries no such row. Read from that one labelled row
 * rather than from the ledger text at large: the ledger also lists gross
 * sales, costs and refunds, so a plain search for an amount could be
 * satisfied by a different row that happens to carry the same figure. The
 * app writes a negative amount as U+2212 before the currency symbol
 * ("−£9.00"), so the sign is normalised and kept — a refund row can never
 * answer for income.
 */
export const totalIncomeEarnedMinor = (ledger: string): number | null => {
  const row = ledger
    .split("\n")
    .find((line) => line.includes(TOTAL_INCOME_EARNED));
  if (row === undefined) return null;
  const amount = row
    .slice(row.indexOf(TOTAL_INCOME_EARNED) + TOTAL_INCOME_EARNED.length)
    .replace(/−/g, "-")
    .replace(/[^\d.-]/g, "");
  const minor = Math.round(Number(amount) * 100);
  return amount === "" || Number.isNaN(minor) ? null : minor;
};

/**
 * Fill and submit the public booking form. For a free listing this lands on the
 * app's thank-you page; for a paid listing the browser is redirected to the
 * provider's hosted checkout (a different origin).
 */
export const submitBooking = async (
  session: BrowserSession,
  ticketPath: string,
  booker: BookerIdentity,
): Promise<void> => {
  step("Submitting booking");
  await session.goto(ticketPath);
  const { page } = session;

  await fillIfPresent(session, "email", booker.email);
  await fillIfPresent(session, "name", booker.name);

  // Quantity field name varies (single `quantity` vs per-listing `quantity_<id>`).
  const qty = page
    .locator('input[name^="quantity"], select[name^="quantity"]')
    .first();
  if (await qty.count()) await setSelectOrInput(qty, "1");

  // The reservations form's own submit control (see form.tsx: its label is
  // the catalog's Continue), so a rename follows the spec.
  const submit = page
    .getByRole("button", {
      name: await catalogWords("common", "common.continue"),
    })
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
 * Set a quantity control that renders as either a `<select>` (small caps) or a
 * plain `<input>` (large caps): choose the option on a select, type the value
 * into an input.
 */
export const setSelectOrInput = async (
  control: Locator,
  value: string,
): Promise<void> => {
  const tag = await control.evaluate((el) => el.tagName.toLowerCase());
  if (tag === "select") await control.selectOption(value);
  else await control.fill(value);
};

/**
 * Wait until the browser has actually left the app for the provider's hosted
 * checkout. If the app stayed and re-rendered the booking page, fail fast with
 * the app's own error alert instead of hunting for card fields that are not
 * there.
 */
export const waitForHostedCheckout = async (
  session: BrowserSession,
): Promise<void> => {
  const appOrigin = new URL(session.baseUrl).origin;
  try {
    await session.page.waitForURL((url) => url.origin !== appOrigin, {
      timeout: config.paymentConfirmTimeoutMs,
    });
  } catch {
    const alert = session.page.locator('.error, [role="alert"]').first();
    const detail = (await alert.count())
      ? (await alert.innerText()).trim()
      : "(no error alert on the page)";
    await session.dumpPage("no-redirect-to-checkout");
    throw new Error(
      `booking did not redirect to the hosted checkout — still on ${session.page.url()}. ` +
        `The app failed to create the payment session. App said: "${detail}". ` +
        "See the app server log tail above for the provider API error.",
    );
  }
};

/** Assert the free-booking thank-you page was reached. */
export const assertFreeThankYou = async (
  session: BrowserSession,
): Promise<void> => {
  await requirePageText(
    session,
    /thank you|your order|your ticket/i,
    "free-booking-no-thankyou",
    "Expected a thank-you page, got:",
  );
  log("  ✔ free booking reached the thank-you page");
};

/** Save the page, then raise the failure — every assert's last resort. */
const failWith = async (
  session: BrowserSession,
  artifact: string,
  problem: string,
): Promise<never> => {
  await session.screenshot(artifact);
  throw new Error(problem);
};

/** Assert a listing recognised no income: its ledger either does not render,
 * or reports exactly zero earned. */
export const requireNoRecognisedIncome = async (
  session: BrowserSession,
): Promise<void> => {
  const ledger = await incomeLedgerText(session);
  if (ledger !== null && totalIncomeEarnedMinor(ledger) !== 0) {
    await failWith(
      session,
      "unexpected-income",
      `income was recognised for a free booking:\n${ledger.slice(0, 400)}`,
    );
  }
};

/** Open a listing's admin page — its Attendees tab for "attendees" (the
 * roster the booking assertions read), or the Overview tab for "overview" —
 * and return the page's body text. The tab link is scoped to the tab strip
 * (`nav.entity-tabs`): the global admin nav also has an "Attendees" link
 * (the site-wide `/admin/attendees` index), and an unscoped match would
 * land on the wrong page. */
export const openListing = async (
  session: BrowserSession,
  listingName: string,
  owner: OwnerCredentials,
  tab: "overview" | "attendees",
): Promise<string> => {
  await session.goto("/admin/");
  await login(session, owner);
  await session.clickLink(listingName);
  if (tab === "overview") return await session.bodyText();
  const attendeesTabLink = session.page
    .locator("nav.entity-tabs a", {
      hasText: await catalogWords("entity-pages", "entity.tab.attendees"),
    })
    .first();
  const attendeesHref = await hrefOf(
    attendeesTabLink,
    "no Attendees tab link found on the listing page",
  );
  await session.goto(attendeesHref);
  return await session.bodyText();
};

/**
 * Cross-check the paid booking in admin: the listing's Overview tab shows the
 * captured income, and its Attendees tab shows the booker. The roster renders
 * only on the Attendees tab, not on the tab reached by clicking the listing
 * name. Returns the Attendees tab's text so a caller can add stricter checks
 * (e.g. that a replayed callback did not book the same order twice).
 */
export const assertBookedInAdmin = async (
  session: BrowserSession,
  identity: BookingIdentity,
  owner: OwnerCredentials,
): Promise<string> => {
  await openListing(session, identity.listingName, owner, "overview");

  // …crucially, that the payment was actually captured. Assert against the
  // listing's INCOME LEDGER specifically — it projects from the payment ledger,
  // so a regression that creates the attendee but drops the payment
  // (price_paid = 0) records no income and the ledger section does not render.
  // Do NOT fall back to scanning the whole page: the listing detail also shows
  // the configured ticket price, which would give a false pass with no payment.
  const paidRegion = await pollUntil(
    config.paymentConfirmTimeoutMs,
    async () => {
      const text = await incomeLedgerText(session);
      if (text !== null) return text;
      await session.page.reload({ waitUntil: "domcontentloaded" });
      return null;
    },
  );
  if (paidRegion === null) {
    return await failWith(
      session,
      "paid-admin-no-income-ledger",
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
  const withDecimals = (identity.priceMinor / 100).toFixed(2); // "1.37" / "2.00"
  const strippedWhole = withDecimals.replace(/\.00$/, ""); //  "1.37" / "2"
  if (
    !paidRegion.includes(withDecimals) &&
    !paidRegion.includes(strippedWhole)
  ) {
    await failWith(
      session,
      "paid-admin-no-income",
      `captured payment not reflected in the listing's income ledger (expected ${withDecimals}). ` +
        `Income ledger:\n${paidRegion.slice(0, 600)}`,
    );
  }

  // 3. The booker itself appears on the Attendees tab, not the Overview tab
  // just checked above.
  const attendeesBody = await openListing(
    session,
    identity.listingName,
    owner,
    "attendees",
  );
  if (!attendeesBody.includes(identity.booker.email)) {
    await failWith(
      session,
      "paid-admin-missing-booker",
      `paid booker ${identity.booker.email} not visible on the admin listing's Attendees tab`,
    );
  }

  log(
    `  ✔ admin listing shows the paid booker (${identity.booker.email}) and captured amount (${withDecimals})`,
  );
  return attendeesBody;
};

/** How many times one text occurs on the attendees roster (replay checks). */
export const countOnRoster = (attendeesBody: string, value: string): number =>
  attendeesBody.split(value).length - 1;

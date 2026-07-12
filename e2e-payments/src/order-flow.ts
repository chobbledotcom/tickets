/**
 * The complex-order journey, against the REAL provider sandbox — the nightly
 * twin of test/e2e/order-journeys.test.ts (which drives the same shapes
 * against stubs):
 *
 *   admin builds a two-member package, sells one member on its own row too,
 *   adds a plain listing, and publishes the /order gallery → a visitor ticks
 *   all three cards, books every path in ONE order, and (paid) settles it on
 *   the provider's hosted checkout → the admin sees one booking row per path
 *   and (paid) each listing's own recognised income.
 *
 * Driven entirely through the UI: group and listing forms, the gallery's
 * checkbox cards, the combined booking page, the hosted checkout.
 */

import type { BrowserSession } from "./browser.ts";
import { config } from "./config.ts";
import {
  createListing,
  incomeLedgerText,
  setSelectOrInput,
  waitForAppReturn,
} from "./flow.ts";
import { log, step } from "./log.ts";

/** The one catalog this journey builds and orders. Prices are minor units;
 * the free leg zeroes them all. */
const KIT = "Order Kit";
const MEMBER_A = "Order Tent"; // in the kit AND sold on its own row
const MEMBER_B = "Order Stove";
const PLAIN = "Order Hamper";
const PRICES = {
  kitMemberA: 400,
  kitMemberB: 600,
  memberAOwn: 500,
  plain: 1500,
};

const BUYER_NAME = "Order Journey Buyer";

/** The numeric id in the current admin URL (/admin/<kind>/<id>…). */
const idFromUrl = (session: BrowserSession, kind: string): number => {
  const match = session.page.url().match(new RegExp(`/admin/${kind}/(\\d+)`));
  if (!match) {
    throw new Error(`no /admin/${kind}/<id> in URL ${session.page.url()}`);
  }
  return Number(match[1]);
};

/** Create a listing through the admin form and return its id — the shared
 * creator leaves the browser on the new listing's admin page. */
const createOrderListing = async (
  session: BrowserSession,
  name: string,
  priceMinor: number,
): Promise<number> => {
  await createListing(session, { name, priceMinor });
  return idFromUrl(session, "listing");
};

/** Create the package group, assign the members to it through their listing
 * edit forms, and set each member's in-package price. Returns the group id. */
const createPackage = async (
  session: BrowserSession,
  members: { id: number; priceMinor: number }[],
): Promise<number> => {
  step(`Creating package "${KIT}"`);
  await session.goto("/admin/groups/new");
  await session.fill("name", KIT);
  await session.check("is_package");
  await session.clickButton("Create Group");
  await session.goto("/admin/groups");
  await session.clickLink(KIT);
  const groupId = idFromUrl(session, "groups");

  for (const member of members) {
    await session.goto(`/admin/listing/${member.id}/edit`);
    await session.check("group_ids", String(groupId));
    await session.clickButton("Save");
  }

  step("Setting the package's member prices");
  await session.goto(`/admin/groups/${groupId}/edit`);
  for (const member of members) {
    await session.fill(
      `package_price_${member.id}`,
      (member.priceMinor / 100).toFixed(2),
    );
  }
  await session.clickButton("Save");
  return groupId;
};

/** Publish the public site and its /order gallery. */
const enableOrderGallery = async (session: BrowserSession): Promise<void> => {
  step("Enabling the public site and the /order gallery");
  await session.goto("/admin/settings");
  await session.check("show_public_site");
  await session.submitLocator(
    session.page
      .locator('form:has(input[name="show_public_site"]) button')
      .first(),
  );
  await session.goto("/admin/site/order");
  await session.check("order_enabled");
  await session.submitLocator(
    session.page
      .locator('form:has(input[name="order_enabled"]) button')
      .first(),
  );
};

/** Tick the gallery cards like a visitor and continue to the booking page. */
const selectOnGallery = async (session: BrowserSession): Promise<void> => {
  step("Selecting the package and listings on /order");
  await session.goto("/order");
  for (const name of [KIT, MEMBER_A, PLAIN]) {
    await session.page
      .locator("label.order-card", { hasText: name })
      .first()
      .click({ force: true, timeout: config.actionTimeoutMs });
  }
  await session.submitLocator(
    session.page.locator("button.order-continue").first(),
  );
  if (!session.page.url().includes("/ticket/")) {
    await session.dumpPage("order-selection-no-booking-page");
    throw new Error(
      `order selection did not reach a booking page (at ${session.page.url()})`,
    );
  }
};

/** Fill the combined booking page: one package, one extra unit of member A on
 * its own row, two of the plain listing — then submit. */
const fillBookingPage = async (session: BrowserSession): Promise<void> => {
  step("Booking every path in one order");
  const { page } = session;
  // The package count is a <select>; per-listing quantities are inputs.
  await page
    .locator('select[name^="package_quantity_"]')
    .first()
    .selectOption("1", { force: true, timeout: config.actionTimeoutMs });
  // A listing's quantity control renders as a <select> for small caps and an
  // <input> for large ones — set whichever the row carries.
  const setRowQty = (name: string, value: string): Promise<void> =>
    setSelectOrInput(
      page
        .locator(`.ticket-row:has-text("${name}") [name^="quantity_"]`)
        .first(),
      value,
      { force: true, timeout: config.actionTimeoutMs },
    );
  await setRowQty(MEMBER_A, "1");
  await setRowQty(PLAIN, "2");
  await session.fill("name", BUYER_NAME);
  await session.fill("email", config.bookerEmail);
  await session.clickButton("Continue");
  log(`  booking submitted; now at ${page.url()}`);
};

/** Wait for the booking to land on the app's success/reserved page (paid
 * orders come back from the hosted checkout; free ones are already there). */
const waitForReturn = (session: BrowserSession): Promise<void> =>
  waitForAppReturn(session, /reserved|success|thank/i, "order-no-return");

/** The app's currency rendering for a minor amount: decimals kept for broken
 * amounts, stripped for whole ones ("4.00" → "4"). */
const rendered = (minor: number): string[] => {
  const withDecimals = (minor / 100).toFixed(2);
  return [withDecimals, withDecimals.replace(/\.00$/, "")];
};

/** Assert a listing's income ledger recognises the given amount. */
const assertListingIncome = async (
  session: BrowserSession,
  listingId: number,
  name: string,
  minor: number,
): Promise<void> => {
  await session.goto(`/admin/listing/${listingId}`);
  const text = await incomeLedgerText(session);
  if (text === null) {
    await session.dumpPage(`order-no-income-ledger-${listingId}`);
    throw new Error(`no income ledger rendered for ${name}`);
  }
  if (!rendered(minor).some((form) => text.includes(form))) {
    await session.dumpPage(`order-wrong-income-${listingId}`);
    throw new Error(
      `${name}: expected recognised income ${(minor / 100).toFixed(2)}, ledger says:\n${text.slice(0, 400)}`,
    );
  }
  log(`  ✔ ${name} recognised ${(minor / 100).toFixed(2)}`);
};

/** Assert the admin sees the order one line per path: member A twice (via the
 * kit and on its own row), labelled with the package's name. */
const assertPerPathEditor = async (
  session: BrowserSession,
  memberAId: number,
): Promise<void> => {
  step("Verifying the order path-by-path in the admin editor");
  await session.goto(`/admin/listing/${memberAId}/attendees`);
  const body = await session.bodyText();
  if (!body.includes(BUYER_NAME)) {
    await session.dumpPage("order-buyer-missing-from-roster");
    throw new Error(`${BUYER_NAME} not on the ${MEMBER_A} roster`);
  }
  // A numeric attendee id specifically — the admin nav's own "Add Attendee"
  // link (/admin/attendees/new) also matches a bare substring.
  const attendeeLink = session.page
    .locator('a[href*="/admin/attendees/"]:not([href$="/new"])')
    .first();
  const href = await attendeeLink.getAttribute("href", {
    timeout: config.navTimeoutMs,
  });
  if (!href) throw new Error("no attendee link on the roster");
  await session.goto(href.startsWith("http") ? new URL(href).pathname : href);
  const editTab = session.page.locator('a[href$="/edit"]').first();
  const editHref = await editTab.getAttribute("href", {
    timeout: config.navTimeoutMs,
  });
  if (!editHref) throw new Error("no edit tab on the attendee page");
  await session.goto(
    editHref.startsWith("http") ? new URL(editHref).pathname : editHref,
  );

  const editor = await session.page.content();
  if (!editor.includes(`via ${KIT}`)) {
    await session.dumpPage("order-editor-missing-path-label");
    throw new Error(`the editor does not label the package path "via ${KIT}"`);
  }
  const memberLines = [
    ...editor.matchAll(/name="line_listing_\d+"[^>]*value="(\d+)"/g),
  ].filter((match) => Number(match[1]) === memberAId).length;
  if (memberLines !== 2) {
    await session.dumpPage("order-editor-wrong-line-count");
    throw new Error(
      `${MEMBER_A} should book through 2 paths (via the kit + its own row); the editor shows ${memberLines}`,
    );
  }
  log(`  ✔ editor shows "via ${KIT}" and both ${MEMBER_A} paths`);
};

/** Run the whole complex-order journey. `paid` legs price the catalog and pay
 * on the hosted checkout the caller settles; the free leg books at once. */
export const runComplexOrderJourney = async (
  session: BrowserSession,
  opts: {
    paid: boolean;
    /** Settle the hosted checkout (the provider's card entry). */
    payHostedCheckout?: () => Promise<void>;
  },
): Promise<void> => {
  step(`Complex order journey (${opts.paid ? "paid" : "free"})`);
  const zeroed = (minor: number): number => (opts.paid ? minor : 0);
  const memberAId = await createOrderListing(
    session,
    MEMBER_A,
    zeroed(PRICES.memberAOwn),
  );
  const memberBId = await createOrderListing(session, MEMBER_B, 0);
  const plainId = await createOrderListing(
    session,
    PLAIN,
    zeroed(PRICES.plain),
  );
  await createPackage(session, [
    { id: memberAId, priceMinor: zeroed(PRICES.kitMemberA) },
    { id: memberBId, priceMinor: zeroed(PRICES.kitMemberB) },
  ]);
  await enableOrderGallery(session);

  await selectOnGallery(session);
  await fillBookingPage(session);

  if (opts.paid) {
    if (!opts.payHostedCheckout) {
      throw new Error("paid journey needs payHostedCheckout");
    }
    await opts.payHostedCheckout();
  }
  // Paid: back from the hosted checkout. Free: already on the reserved page.
  await waitForReturn(session);

  await assertPerPathEditor(session, memberAId);
  if (opts.paid) {
    // Each listing recognises its own paths' income: member A one kit unit +
    // one unit on its own row; the plain listing two units.
    await assertListingIncome(
      session,
      memberAId,
      MEMBER_A,
      PRICES.kitMemberA + PRICES.memberAOwn,
    );
    await assertListingIncome(session, plainId, PLAIN, PRICES.plain * 2);
  }
  step(`PASS — complex order journey (${opts.paid ? "paid" : "free"})`);
};

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

/* jscpd:ignore-start */
import { type BrowserSession, hrefOf } from "./browser.ts";
import {
  type BookerIdentity,
  config,
  type OwnerCredentials,
} from "./config.ts";
import {
  createListing,
  incomeLedgerText,
  setSelectOrInput,
  totalIncomeEarnedMinor,
  waitForAppReturn,
  waitForHostedCheckout,
} from "./flow.ts";
import { log, step } from "./log.ts";

/* jscpd:ignore-end */

/** Prices in minor units; the free leg zeroes them all. */
const PRICES = {
  kitMemberA: 400,
  kitMemberB: 600,
  memberAOwn: 500,
  plain: 1500,
} as const;

/** The one catalog this journey builds and orders, named for this scenario. */
export interface OrderCatalog {
  kit: string;
  memberA: string;
  memberB: string;
  plain: string;
}

export interface OrderJourneyIdentity {
  booker: BookerIdentity;
  catalog: OrderCatalog;
  owner: OwnerCredentials;
}

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
  catalog: OrderCatalog,
  members: { id: number; priceMinor: number }[],
): Promise<number> => {
  step(`Creating package "${catalog.kit}"`);
  await session.goto("/admin/groups/new");
  await session.fill("name", catalog.kit);
  await session.check("is_package");
  await session.clickButton("Create Group");
  await session.goto("/admin/groups");
  await session.clickLink(catalog.kit);
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
  await session.goto("/admin/features/site");
  await session.check("enabled", "true");
  await session.submitLocator(
    session.page.locator('form:has(input[name="enabled"]) button').first(),
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
const selectOnGallery = async (
  session: BrowserSession,
  catalog: OrderCatalog,
): Promise<void> => {
  step("Selecting the package and listings on /order");
  await session.goto("/order");
  for (const name of [catalog.kit, catalog.memberA, catalog.plain]) {
    await session.page
      .locator("label.order-card", { hasText: name })
      .first()
      .click({ timeout: config.actionTimeoutMs });
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
const fillBookingPage = async (
  session: BrowserSession,
  identity: OrderJourneyIdentity,
): Promise<void> => {
  step("Booking every path in one order");
  const { page } = session;
  // The package count is a <select>; per-listing quantities are inputs.
  await page
    .locator('select[name^="package_quantity_"]')
    .first()
    .selectOption("1", { timeout: config.actionTimeoutMs });
  // A listing's quantity control renders as a <select> for small caps and an
  // <input> for large ones — set whichever the row carries.
  const setRowQty = (name: string, value: string): Promise<void> =>
    setSelectOrInput(
      page
        .locator(`.ticket-row:has-text("${name}") [name^="quantity_"]`)
        .first(),
      value,
    );
  await setRowQty(identity.catalog.memberA, "1");
  await setRowQty(identity.catalog.plain, "2");
  await session.fill("name", identity.booker.name);
  await session.fill("email", identity.booker.email);
  await session.clickButton("Continue");
  log(`  booking submitted; now at ${page.url()}`);
};

/** Wait for the booking to land on the app's success/reserved page (paid
 * orders come back from the hosted checkout; free ones are already there). */
const waitForReturn = (session: BrowserSession): Promise<void> =>
  waitForAppReturn(session, /reserved|success|thank/i, "order-no-return");

/** Assert a listing's income ledger reports exactly this much earned. */
const assertListingIncome = async (
  session: BrowserSession,
  listingId: number,
  name: string,
  minor: number,
): Promise<void> => {
  await session.goto(`/admin/listing/${listingId}`);
  const text = await incomeLedgerText(session);
  const earned = text === null ? null : totalIncomeEarnedMinor(text);
  if (earned === minor) {
    log(`  ✔ ${name} recognised ${(minor / 100).toFixed(2)}`);
    return;
  }
  await session.dumpPage(`order-income-problem-${listingId}`);
  throw new Error(
    text === null
      ? `no income ledger rendered for ${name}`
      : `${name}: expected ${minor} minor units of income earned, the ledger ` +
          `reports ${earned}:\n${text.slice(0, 400)}`,
  );
};

/** Assert the admin sees the order one line per path: member A twice (via the
 * kit and on its own row), member B once (via the kit), labelled with the
 * package's name. */
const assertPerPathEditor = async (
  session: BrowserSession,
  identity: OrderJourneyIdentity,
  built: BuiltOrderCatalog,
): Promise<void> => {
  const { booker, catalog } = identity;
  step("Verifying the order path-by-path in the admin editor");
  await session.goto(`/admin/listing/${built.memberAId}/attendees`);
  const body = await session.bodyText();
  if (!body.includes(booker.name)) {
    await session.dumpPage("order-buyer-missing-from-roster");
    throw new Error(`${booker.name} not on the ${catalog.memberA} roster`);
  }
  // A numeric attendee id specifically — the admin nav's own "Add Attendee"
  // link (/admin/attendees/new) also matches a bare substring.
  const attendeeLink = session.page
    .locator('a[href*="/admin/attendees/"]:not([href$="/new"])')
    .first();
  const href = await hrefOf(attendeeLink, "no attendee link on the roster");
  await session.goto(href.startsWith("http") ? new URL(href).pathname : href);
  const editTab = session.page.locator('a[href$="/edit"]').first();
  const editHref = await hrefOf(editTab, "no edit tab on the attendee page");
  await session.goto(
    editHref.startsWith("http") ? new URL(editHref).pathname : editHref,
  );

  const editor = await session.page.content();
  if (!editor.includes(`via ${catalog.kit}`)) {
    await session.dumpPage("order-editor-missing-path-label");
    throw new Error(
      `the editor does not label the package path "via ${catalog.kit}"`,
    );
  }
  // A stored booking row carries its non-empty `line_key_<n>`; the editor
  // also renders blank per-path creation lines (empty key), which are offers,
  // not bookings — only the stored rows count as booked paths.
  const isStoredLine = (index: string): boolean =>
    new RegExp(`name="line_key_${index}"[^>]*value="[^"]+"`).test(editor);
  const linesFor = (listingId: number): number =>
    [...editor.matchAll(/name="line_listing_(\d+)"[^>]*value="(\d+)"/g)].filter(
      (match) => Number(match[2]) === listingId && isStoredLine(match[1]),
    ).length;
  const expectedLines: [string, number, number][] = [
    [`${catalog.memberA} (via the kit + its own row)`, built.memberAId, 2],
    [`${catalog.memberB} (via the kit)`, built.memberBId, 1],
    [`${catalog.plain} (its own row)`, built.plainId, 1],
  ];
  for (const [what, listingId, expected] of expectedLines) {
    const lines = linesFor(listingId);
    if (lines !== expected) {
      await session.dumpPage("order-editor-wrong-line-count");
      throw new Error(
        `${what} should book through ${expected} path(s); the editor shows ${lines}`,
      );
    }
  }
  log(
    `  ✔ editor shows "via ${catalog.kit}" and every member path (A twice, B once)`,
  );
};

/** What the catalog builder created, for the booking step to assert against. */
export interface BuiltOrderCatalog {
  memberAId: number;
  memberBId: number;
  plainId: number;
}

/**
 * Build the complex-order catalog — the two-member package (member A also on
 * its own row), the plain listing, and the published /order gallery — leaving
 * the visitor's booking to `bookComplexOrder`. `paid` prices the catalog; the
 * free leg zeroes it.
 */
export const buildOrderCatalog = async (
  session: BrowserSession,
  identity: OrderJourneyIdentity,
  opts: { paid: boolean },
): Promise<BuiltOrderCatalog> => {
  const { catalog } = identity;
  const zeroed = (minor: number): number => (opts.paid ? minor : 0);
  const memberAId = await createOrderListing(
    session,
    catalog.memberA,
    zeroed(PRICES.memberAOwn),
  );
  const memberBId = await createOrderListing(session, catalog.memberB, 0);
  const plainId = await createOrderListing(
    session,
    catalog.plain,
    zeroed(PRICES.plain),
  );
  await createPackage(session, catalog, [
    { id: memberAId, priceMinor: zeroed(PRICES.kitMemberA) },
    { id: memberBId, priceMinor: zeroed(PRICES.kitMemberB) },
  ]);
  await enableOrderGallery(session);
  return { memberAId, memberBId, plainId };
};

/** The visitor's half: select on the gallery, book every path in one order,
 * and settle the hosted checkout (paid legs). */
export const bookComplexOrder = async (
  session: BrowserSession,
  identity: OrderJourneyIdentity,
  opts: {
    paid: boolean;
    payHostedCheckout?: () => Promise<void>;
  },
): Promise<void> => {
  await selectOnGallery(session, identity.catalog);
  await fillBookingPage(session, identity);
  if (opts.paid) {
    if (!opts.payHostedCheckout) {
      throw new Error("paid journey needs payHostedCheckout");
    }
    // The booking POST lands on an app reserved page first; only once the
    // browser has actually left for the provider's hosted checkout does the
    // payment session exist for the provider driver to settle.
    await waitForHostedCheckout(session);
    await opts.payHostedCheckout();
  }
  // Paid: back from the hosted checkout. Free: already on the reserved page.
  await waitForReturn(session);
};

/** The admin verification of a completed complex order: one line per path
 * (member A twice — via the kit and on its own row — and member B once,
 * labelled with the package's name), and — when `expectIncome` — each
 * listing recognising its own paths' income (member A one kit unit plus one
 * own-row unit; member B its one kit unit; the plain listing two units). */
export const verifyComplexOrder = async (
  session: BrowserSession,
  identity: OrderJourneyIdentity,
  built: BuiltOrderCatalog,
  { expectIncome }: { expectIncome: boolean },
): Promise<void> => {
  await assertPerPathEditor(session, identity, built);
  if (!expectIncome) return;
  const { catalog } = identity;
  const expected: [number, string, number][] = [
    [built.memberAId, catalog.memberA, PRICES.kitMemberA + PRICES.memberAOwn],
    [built.memberBId, catalog.memberB, PRICES.kitMemberB],
    [built.plainId, catalog.plain, PRICES.plain * 2],
  ];
  for (const [listingId, name, minor] of expected) {
    await assertListingIncome(session, listingId, name, minor);
  }
  step("PASS — complex order journey");
};

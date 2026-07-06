/**
 * The order-journey e2e harness: mint a catalog of listing shapes, walk the
 * REAL buyer journey — /order gallery → card selection → combined booking
 * page → submit (free books at once; paid completes through the provider's
 * webhook with the exact intent the form produced) — run the caller's
 * post-booking innards (admin edits, nothing at all, …), then verify the
 * stored order row-for-row.
 *
 *   await runOrderJourney({
 *     catalog: { packages: [...], listings: [...], parents: [...] },
 *     select: { packages: ["Kit"], listings: ["Tent"], date },
 *     form: (c) => ({ [`package_quantity_${c.group("Kit").id}`]: "1", ... }),
 *     rows: (c) => [[c.listing("Tent").id, c.group("Kit").id, 0, 2, ""]],
 *     through: async (ctx) => { ...innards... },
 *   });
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { queryAll } from "#shared/db/client.ts";
import { setGroupPackageMembers, setListingGroups } from "#shared/db/groups.ts";
import { setChildIds } from "#shared/db/listing-parents.ts";
import { settings } from "#shared/db/settings.ts";
import {
  PACKAGE_SELECT_PREFIX,
  SELECT_PREFIX,
  START_DATE_FIELD,
} from "#shared/order-select.ts";
import {
  buildItemsMetadata,
  enforceMetadataLimits,
  STRIPE_METADATA_MAX_ENTRIES,
  STRIPE_METADATA_MAX_VALUE_LENGTH,
} from "#shared/payment-helpers.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import type { Group, Listing } from "#shared/types.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

/** One package in a journey's catalog: its members sell inside the bundle at
 * the given price (each `quantity` per package unit, default 1). */
export type JourneyPackage = {
  name: string;
  members: { name: string; price: number; quantity?: number }[];
};

/** One standalone listing: free unless priced, dateless unless `daily`. */
export type JourneyListing = {
  name: string;
  price?: number;
  daily?: boolean;
};

/** A parent listing whose sole bookable-alone child auto-folds under it. */
export type JourneyParent = { name: string; childName: string };

export type JourneyCatalogSpec = {
  packages: JourneyPackage[];
  listings: JourneyListing[];
  parents: JourneyParent[];
};

/** The minted catalog, looked up by the spec's names. */
export type JourneyCatalog = {
  group: (name: string) => Group;
  listing: (name: string) => Listing;
};

/** Everything a journey hands to its innards and follow-up assertions. */
export type OrderJourneyCtx = {
  /** An admin logged in through the real login form. */
  browser: TestBrowser;
  catalog: JourneyCatalog;
  attendeeId: number;
};

/** A stored order as comparable tuples:
 * [listing, package path, parent, quantity, date ("" when dateless)]. */
export type StoredOrderRow = [number, number, number, number, string];

const byRowIdentity = (a: StoredOrderRow, b: StoredOrderRow): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Assert the attendee's stored booking rows, whatever order they landed in. */
export const expectStoredOrder = async (
  attendeeId: number,
  expected: StoredOrderRow[],
): Promise<void> => {
  const rows = await queryAll<{
    listing_id: number;
    package_group_id: number;
    parent_listing_id: number;
    quantity: number;
    start_day: string | null;
  }>(
    `SELECT listing_id, package_group_id, parent_listing_id, quantity,
            DATE(start_at) AS start_day
       FROM listing_attendees WHERE attendee_id = ?`,
    [attendeeId],
  );
  expect(
    rows
      .map(
        (row): StoredOrderRow => [
          Number(row.listing_id),
          Number(row.package_group_id),
          Number(row.parent_listing_id),
          Number(row.quantity),
          row.start_day ?? "",
        ],
      )
      .sort(byRowIdentity),
  ).toEqual([...expected].sort(byRowIdentity));
};

/** Mint the spec's catalog: packages with priced members, plain/daily
 * listings, and parents with a sole bookable-alone child each. */
const mintCatalog = async (
  spec: JourneyCatalogSpec,
): Promise<JourneyCatalog> => {
  const groups = new Map<string, Group>();
  const listings = new Map<string, Listing>();
  // A member shared by several packages belongs to every one of their groups.
  const memberGroupIds = new Map<string, number[]>();
  for (const pkg of spec.packages) {
    const group = await createTestGroup({ isPackage: true, name: pkg.name });
    groups.set(pkg.name, group);
    for (const member of pkg.members) {
      const listing =
        listings.get(member.name) ??
        (await createTestListing({
          groupId: group.id,
          maxAttendees: 20,
          maxQuantity: 5,
          name: member.name,
          thankYouUrl: "",
          unitPrice: member.price,
        }));
      listings.set(member.name, listing);
      memberGroupIds.set(member.name, [
        ...(memberGroupIds.get(member.name) ?? []),
        group.id,
      ]);
    }
  }
  for (const [name, groupIds] of memberGroupIds) {
    await setListingGroups(listings.get(name)!.id, groupIds);
  }
  for (const pkg of spec.packages) {
    await setGroupPackageMembers(
      groups.get(pkg.name)!.id,
      pkg.members.map((member) => ({
        listingId: listings.get(member.name)!.id,
        price: member.price,
        ...(member.quantity === undefined ? {} : { quantity: member.quantity }),
      })),
    );
  }
  for (const item of spec.listings) {
    listings.set(
      item.name,
      item.daily
        ? await createDailyTestListing({
            name: item.name,
            thankYouUrl: "",
            unitPrice: item.price ?? 0,
          })
        : await createTestListing({
            maxAttendees: 20,
            maxQuantity: 5,
            name: item.name,
            thankYouUrl: "",
            unitPrice: item.price ?? 0,
          }),
    );
  }
  for (const parent of spec.parents) {
    const parentListing = await createTestListing({
      maxAttendees: 20,
      name: parent.name,
      thankYouUrl: "",
      unitPrice: 0,
    });
    const child = await createTestListing({
      bookableAlone: true,
      maxAttendees: 20,
      maxQuantity: 5,
      name: parent.childName,
      thankYouUrl: "",
      unitPrice: 0,
    });
    await setChildIds(parentListing.id, [child.id]);
    listings.set(parent.name, parentListing);
    listings.set(parent.childName, child);
  }
  return {
    // The specs name only things they minted, so the lookups always hit.
    group: (name: string) => groups.get(name)!,
    listing: (name: string) => listings.get(name)!,
  };
};

/** Log a fresh browser in as the seeded admin through the real login form. */
const adminBrowser = async (): Promise<TestBrowser> => {
  const browser = new TestBrowser();
  await browser.visit("/admin/");
  await browser.submitForm(
    { password: TEST_ADMIN_PASSWORD, username: TEST_ADMIN_USERNAME },
    "Login",
  );
  return browser;
};

/** The gallery's GET-form serialisation for the journey's picks. */
const selectionUrl = (
  catalog: JourneyCatalog,
  select: { packages: string[]; listings: string[]; date?: string },
): string => {
  const picks = [
    ...select.packages.map(
      (name) => `${PACKAGE_SELECT_PREFIX}${catalog.group(name).id}=1`,
    ),
    ...select.listings.map(
      (name) => `${SELECT_PREFIX}${catalog.listing(name).id}=1`,
    ),
    ...(select.date === undefined
      ? []
      : [`${START_DATE_FIELD}=${select.date}`]),
  ];
  return `/order?${picks.join("&")}`;
};

/** Complete the captured checkout through the provider webhook, exactly as
 * the app signed it: same intent, same metadata builder, same caps. */
const completePaidCheckout = async (
  intent: CheckoutIntent,
  sessionId: string,
): Promise<void> => {
  const total = priceCheckout(intent).total;
  const metadata = enforceMetadataLimits(
    await buildItemsMetadata(
      intent,
      total,
      STRIPE_METADATA_MAX_VALUE_LENGTH,
      STRIPE_METADATA_MAX_ENTRIES,
    ),
    STRIPE_METADATA_MAX_VALUE_LENGTH,
    STRIPE_METADATA_MAX_ENTRIES,
  );
  const verifyStub = await stubWebhookVerify({
    data: {
      object: {
        amount_total: total,
        id: sessionId,
        metadata,
        payment_intent: `pi_${sessionId}`,
        payment_status: "paid",
      },
    },
    id: `evt_${sessionId}`,
    type: "checkout.session.completed",
  });
  try {
    const response = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
    );
    expect(response.status).toBe(200);
  } finally {
    verifyStub.restore();
  }
};

/** Run one order journey end to end and verify the stored rows. Returns the
 * ctx so tests can go on to assert admin pages, money, or anything else. */
export const runOrderJourney = async (spec: {
  catalog: JourneyCatalogSpec;
  /** The cards the buyer ticks on the gallery, by catalog name. */
  select: { packages: string[]; listings: string[]; date?: string };
  /** The booking form's fields (quantities, contact overrides, …). */
  form: (catalog: JourneyCatalog) => Record<string, string>;
  /** Complete the checkout through the payment provider. */
  paid?: boolean;
  /** The rows the stored order must hold after the innards ran. */
  rows: (catalog: JourneyCatalog) => StoredOrderRow[];
  /** Post-booking innards, run before the rows are verified. */
  through?: (ctx: OrderJourneyCtx) => Promise<void>;
}): Promise<OrderJourneyCtx> => {
  await settings.update.showPublicSite(true);
  await settings.update.orderEnabled(true);
  if (spec.paid) await setupStripe();
  const browser = await adminBrowser();
  const catalog = await mintCatalog(spec.catalog);

  // The gallery offers every picked card, and the selection redirects to the
  // combined booking page.
  await browser.visit("/order");
  for (const name of [...spec.select.packages, ...spec.select.listings]) {
    expect(browser.containsText(name)).toBe(true);
  }
  await browser.visit(selectionUrl(catalog, spec.select));
  expect(browser.currentUrl).toContain("/ticket/");

  // Every control the journey means to fill must actually render — a path
  // whose input silently vanished would otherwise just book less.
  const filled = spec.form(catalog);
  for (const field of Object.keys(filled)) {
    expect(browser.currentHtml).toContain(`name="${field}"`);
  }
  const fields = {
    email: "journey@example.com",
    name: "Journey Buyer",
    ...filled,
  };
  const captured: { intent: CheckoutIntent | null } = { intent: null };
  const sessionId = "cs_order_journey";
  const checkoutStub = spec.paid
    ? stub(stripePaymentProvider, "createCheckoutSession", (intent) => {
        captured.intent = intent;
        return Promise.resolve({
          checkoutUrl: "https://journey.test/checkout",
          sessionId,
        });
      })
    : null;
  try {
    await browser.submitForm(fields, "Continue");
    if (checkoutStub === null) {
      // A free order books immediately.
      expect(browser.currentUrl).toBe("/ticket/reserved");
    } else {
      expect(captured.intent).not.toBeNull();
      await completePaidCheckout(captured.intent!, sessionId);
    }
  } finally {
    checkoutStub?.restore();
    if (spec.paid) resetStripeClient();
  }

  const expectedRows = spec.rows(catalog);
  const firstListingId = expectedRows[0]![0];
  const attendee = await queryAll<{ attendee_id: number }>(
    "SELECT attendee_id FROM listing_attendees WHERE listing_id = ? LIMIT 1",
    [firstListingId],
  );
  const ctx: OrderJourneyCtx = {
    attendeeId: Number(attendee[0]!.attendee_id),
    browser,
    catalog,
  };
  await spec.through?.(ctx);
  await expectStoredOrder(ctx.attendeeId, expectedRows);
  return ctx;
};

// ---------------------------------------------------------------------------
// Admin-editor assertions shared by journey tests.
// ---------------------------------------------------------------------------

/** Walk from a listing's roster to the buyer's editor tab. */
export const openEditorFromRoster = async (
  browser: TestBrowser,
  listingId: number,
  buyer: string,
): Promise<void> => {
  await browser.visit(`/admin/listing/${listingId}/attendees`);
  // The buyer is on the roster, so their attendee link (and the editor tab
  // behind it) always exists.
  expect(browser.containsText(buyer)).toBe(true);
  const link = browser.links.find((l) =>
    /\/admin\/attendees\/\d+$/.test(l.href),
  )!;
  await browser.visit(link.href);
  const editTab = browser.links.find((l) =>
    /\/admin\/attendees\/\d+\/edit$/.test(l.href),
  )!;
  await browser.visit(editTab.href);
};

/** The value of the editor line's quantity box at `index` — callers pass an
 * index scraped from the same page, so the box always exists. */
export const lineQty = (html: string, index: string): string =>
  new RegExp(`name="qty_${index}"[^>]*value="([^"]*)"`).exec(html)![1]!;

/** How many editor lines target the listing (across every path). */
export const lineCountFor = (html: string, listingId: number): number =>
  [...html.matchAll(/name="line_listing_\d+"[^>]*value="(\d+)"/g)].filter(
    (match) => Number(match[1]) === listingId,
  ).length;

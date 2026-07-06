/**
 * One VERY mixed public order, validated end-to-end on the admin side.
 *
 * The buyer walks the real journey — /order gallery selection → cart booking
 * page → reservation — putting every listing shape into ONE order:
 *
 *   - a package ("Mega Kit": 2× Tent + 1× Stove per unit),
 *   - the Tent AGAIN standalone (the same listing through two paths),
 *   - a parent ("Marquee") whose sole bookable-alone child ("Generator")
 *     auto-folds under it, PLUS the Generator standalone by its own card,
 *   - a plain listing ("T-Shirt"),
 *   - a daily listing ("Campervan") on a chosen date.
 *
 * The admin then sees the order exactly as stored: one editor line per path,
 * labelled by path, with the stored rows to match.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { addDays } from "#shared/dates.ts";
import { queryAll } from "#shared/db/client.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { setChildIds } from "#shared/db/listing-parents.ts";
import { settings } from "#shared/db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { Group, Listing } from "#shared/types.ts";
import {
  attendeeLineIndex,
  createDailyTestListing,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  getAttendeesRaw,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils";
import { TestBrowser } from "#test-utils/test-browser.ts";

/** The whole catalog one complex order draws from. */
type Catalog = {
  kit: Group;
  tent: Listing;
  stove: Listing;
  marquee: Listing;
  generator: Listing;
  tshirt: Listing;
  campervan: Listing;
};

/** Free listings of every shape: a two-member package, a parent with a
 * bookable-alone sole child, a plain listing, and a daily listing. */
const buildCatalog = async (): Promise<Catalog> => {
  const kit = await createTestGroup({ isPackage: true, name: "Mega Kit" });
  const tent = await createTestListing({
    groupId: kit.id,
    maxAttendees: 20,
    maxQuantity: 5,
    name: "Tent",
    unitPrice: 0,
  });
  const stove = await createTestListing({
    groupId: kit.id,
    maxAttendees: 20,
    name: "Stove",
    unitPrice: 0,
  });
  await setGroupPackageMembers(kit.id, [
    { listingId: tent.id, price: 0, quantity: 2 },
    { listingId: stove.id, price: 0 },
  ]);
  const marquee = await createTestListing({
    maxAttendees: 20,
    name: "Marquee",
    unitPrice: 0,
  });
  const generator = await createTestListing({
    bookableAlone: true,
    maxAttendees: 20,
    maxQuantity: 5,
    name: "Generator",
    unitPrice: 0,
  });
  await setChildIds(marquee.id, [generator.id]);
  const tshirt = await createTestListing({
    maxAttendees: 20,
    maxQuantity: 5,
    name: "T-Shirt",
    unitPrice: 0,
  });
  const campervan = await createDailyTestListing({
    name: "Campervan",
    unitPrice: 0,
  });
  return { campervan, generator, kit, marquee, stove, tent, tshirt };
};

/** The order-gallery selection URL for the whole catalog on `date` — exactly
 * what the gallery's GET form serialises to. */
const selectionUrl = (catalog: Catalog, date: string): string => {
  const picks = [
    `select_package_${catalog.kit.id}=1`,
    ...[
      catalog.tent,
      catalog.marquee,
      catalog.generator,
      catalog.tshirt,
      catalog.campervan,
    ].map((listing) => `select_${listing.id}=1`),
  ];
  return `/order?${picks.join("&")}&start_date=${date}`;
};

/** Every stored booking row of the order, as comparable tuples:
 * [listing, package path, parent, quantity, date ("" when dateless)]. */
const storedRows = async (
  attendeeId: number,
): Promise<[number, number, number, number, string][]> => {
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
  return rows
    .map((row): [number, number, number, number, string] => [
      Number(row.listing_id),
      Number(row.package_group_id),
      Number(row.parent_listing_id),
      Number(row.quantity),
      row.start_day ?? "",
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
};

/** The value of the editor line's quantity box at `index`. */
const lineQty = (html: string, index: string): string =>
  new RegExp(`name="qty_${index}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? "";

/** How many editor lines target the listing (across every path). */
const lineCountFor = (html: string, listingId: number): number =>
  [...html.matchAll(/name="line_listing_\d+"[^>]*value="(\d+)"/g)].filter(
    (match) => Number(match[1]) === listingId,
  ).length;

/** Walk from a listing's roster to the buyer's editor tab. */
const openEditorFromRoster = async (
  browser: TestBrowser,
  listingId: number,
  buyer: string,
): Promise<void> => {
  await browser.visit(`/admin/listing/${listingId}/attendees`);
  expect(browser.containsText(buyer)).toBe(true);
  const link = browser.links.find((l) =>
    /\/admin\/attendees\/\d+$/.test(l.href),
  );
  if (!link) throw new Error("no attendee link on the roster");
  await browser.visit(link.href);
  const editTab = browser.links.find((l) =>
    /\/admin\/attendees\/\d+\/edit$/.test(l.href),
  )!;
  await browser.visit(editTab.href);
};

describeWithEnv("e2e: one complex mixed order", { db: true }, () => {
  test("package + overlap + parent/child + plain + daily book as one order the admin can read", async () => {
    // The public site and its order gallery are opt-in settings; the env
    // teardown resets them with the database.
    await settings.update.showPublicSite(true);
    await settings.update.orderEnabled(true);
    // The admin half of the journey drives the real pages, logged in through
    // the real login form.
    const browser = new TestBrowser();
    await browser.visit("/admin/");
    await browser.submitForm(
      { password: TEST_ADMIN_PASSWORD, username: TEST_ADMIN_USERNAME },
      "Login",
    );
    const catalog = await buildCatalog();
    const date = addDays(todayInTz(settings.timezone), 3);

    // The gallery offers every shape as a card (members of a visible package
    // included), and the selection redirects to the combined booking page.
    await browser.visit("/order");
    for (const name of [
      "Mega Kit",
      "Tent",
      "Marquee",
      "Generator",
      "T-Shirt",
      "Campervan",
    ]) {
      expect(browser.containsText(name)).toBe(true);
    }
    await browser.visit(selectionUrl(catalog, date));
    expect(browser.currentUrl).toContain("/ticket/");

    // The booking page renders every path's control: the package's count, the
    // member's OWN row beside it, the parent (whose sole child auto-folds),
    // the child's own row, the plain row, and the daily date.
    const page = browser.currentHtml;
    expect(page).toContain(`name="package_quantity_${catalog.kit.id}"`);
    for (const listing of [
      catalog.tent,
      catalog.marquee,
      catalog.generator,
      catalog.tshirt,
      catalog.campervan,
    ]) {
      expect(page).toContain(`name="quantity_${listing.id}"`);
    }
    expect(page).toContain(`name="date"`);

    await browser.submitForm(
      {
        date,
        email: "complex@example.com",
        name: "Complex Buyer",
        [`package_quantity_${catalog.kit.id}`]: "1",
        [`quantity_${catalog.campervan.id}`]: "1",
        [`quantity_${catalog.generator.id}`]: "1",
        [`quantity_${catalog.marquee.id}`]: "1",
        [`quantity_${catalog.tent.id}`]: "1",
        [`quantity_${catalog.tshirt.id}`]: "3",
      },
      "Continue",
    );
    // A free order books immediately and lands on the reservation page.
    expect(browser.currentUrl).toBe("/ticket/reserved");

    // The stored order: one row per path — the tent through the package (2 a
    // unit) AND its own row, the generator folded under the marquee AND its
    // own row, and the campervan on the chosen date.
    const attendeeId = (await getAttendeesRaw(catalog.tent.id))[0]!.id;
    expect(await storedRows(attendeeId)).toEqual(
      (
        [
          [catalog.tent.id, catalog.kit.id, 0, 2, ""],
          [catalog.tent.id, 0, 0, 1, ""],
          [catalog.stove.id, catalog.kit.id, 0, 1, ""],
          [catalog.marquee.id, 0, 0, 1, ""],
          [catalog.generator.id, 0, catalog.marquee.id, 1, ""],
          [catalog.generator.id, 0, 0, 1, ""],
          [catalog.tshirt.id, 0, 0, 3, ""],
          [catalog.campervan.id, 0, 0, 1, date],
        ] as [number, number, number, number, string][]
      ).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]),
    );

    // Admin: from the Tent roster to the buyer's editor — one line per path,
    // each labelled by its path, quantities as booked.
    await openEditorFromRoster(browser, catalog.tent.id, "Complex Buyer");
    const editor = browser.currentHtml;
    const tentViaKit = attendeeLineIndex(
      editor,
      catalog.tent.id,
      catalog.kit.id,
    );
    const tentOwnRow = attendeeLineIndex(editor, catalog.tent.id, 0);
    expect(tentViaKit).not.toBeNull();
    expect(tentOwnRow).not.toBeNull();
    expect(tentViaKit).not.toBe(tentOwnRow);
    expect(lineQty(editor, tentViaKit!)).toBe("2");
    expect(lineQty(editor, tentOwnRow!)).toBe("1");
    expect(
      lineQty(
        editor,
        attendeeLineIndex(editor, catalog.stove.id, catalog.kit.id)!,
      ),
    ).toBe("1");
    expect(
      lineQty(editor, attendeeLineIndex(editor, catalog.tshirt.id, 0)!),
    ).toBe("3");
    expect(browser.containsText("via Mega Kit")).toBe(true);
    expect(browser.containsText("add-on under Marquee")).toBe(true);
    // The generator books twice — folded under the marquee and standalone.
    expect(lineCountFor(editor, catalog.generator.id)).toBe(2);
    // The shared date range carries the campervan's booked date.
    expect(editor).toContain(`name="start_date"`);
    expect(editor).toContain(`value="${date}"`);

    // The rosters agree: every listing in the order lists the buyer.
    for (const listing of [catalog.stove, catalog.campervan]) {
      await browser.visit(`/admin/listing/${listing.id}/attendees`);
      expect(browser.containsText("Complex Buyer")).toBe(true);
    }
  });
});

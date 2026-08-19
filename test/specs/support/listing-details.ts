/**
 * Details an owner states about what they sell, and what a visitor reading a
 * listing's page is shown. The visitor's half opens the real public page,
 * because that is where a detail earns its keep.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { getAllAttributesWithOptions } from "#db/attributes.ts";
import {
  openAdminPage,
  openAsNewcomer,
  takesDownFromOwnPage,
} from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  listingNamed,
  tickOnListingTab,
} from "#test/specs/support/listings.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The detail this story keeps, or a loud failure when it never kept one. */
const keptDetail = (world: TicketsWorld): { id: number; name: string } =>
  requiredWorldValue(world.listingDetail, "the detail the owner keeps");

/** The owner keeps a detail with the wordings it can take, through the pages
 * the site serves. The id is read from where the site sent them, so
 * everything later acts on the detail the site really made. */
export const ownerKeepsDetail = async (
  world: TicketsWorld,
  name: string,
  wordings: string[],
): Promise<void> => {
  const browser = await openAdminPage(world, "/admin/attributes");
  await fillInAndSend(browser, { name }, "Add attribute");
  const sentTo = requiredWorldValue(
    browser.currentUrl.match(/\/admin\/attributes\/(\d+)/),
    `the page for the detail ${name}`,
  );
  world.listingDetail = { id: Number(sentTo[1]), name };
  for (const wording of wordings) {
    await fillInAndSend(browser, { text: wording }, "Add option");
  }
  for (const wording of wordings) {
    expect(browser.pageText).toContain(wording);
  }
};

/** The stored id behind one wording, or a loud failure — marking a listing
 * with a wording the site does not offer would prove nothing. */
const wordingId = async (
  world: TicketsWorld,
  wording: string,
): Promise<number> => {
  const detail = keptDetail(world);
  const attribute = requiredWorldValue(
    (await getAllAttributesWithOptions()).find((row) => row.id === detail.id),
    `the stored detail ${detail.name}`,
  );
  const option = requiredWorldValue(
    attribute.options.find((row) => row.text === wording),
    `the wording "${wording}" on ${detail.name}`,
  );
  return option.id;
};

/** The owner marks a listing with one wording, ticking the box the listing's
 * own page offers. */
export const ownerMarksListing = async (
  world: TicketsWorld,
  listingName: string,
  wording: string,
): Promise<void> =>
  tickOnListingTab(
    world,
    listingName,
    "attributes",
    "option_ids",
    await wordingId(world, wording),
    "Attributes updated",
  );

/** What a visitor reading this listing's page is shown, opened by somebody
 * who was never signed in. */
export const visitorReadsListingPage = async (
  world: TicketsWorld,
  listingName: string,
): Promise<string> =>
  (await openAsNewcomer(`/ticket/${listingNamed(world, listingName).slug}`))
    .pageText;

/** The owner removes the detail from its own page, typing a name to confirm,
 * and keeps what the site said. */
export const ownerRemovesDetail = takesDownFromOwnPage(
  (world) => openAdminPage(world, `/admin/attributes/${keptDetail(world).id}`),
  "Delete attribute",
);

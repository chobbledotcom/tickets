/**
 * An editor: somebody the owner lets write listings, and nothing else. Every
 * step here goes through the pages a real person would use — the owner's invite
 * form, the link it hands over, the login form, and the editor's own listing
 * pages — so a page that stopped working fails the story rather than being
 * stepped around.
 */

import { expect } from "@std/expect";
import { t } from "#i18n";
import { toMinorUnits } from "#shared/currency.ts";
import {
  getAllListings,
  getListingWithCount,
} from "#shared/db/listings/records.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import { whyValueCannotBeSent } from "#test/specs/support/form-controls.ts";
import { rememberStayListing, stayListing } from "#test/specs/support/stays.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

/** Where a listing forwards each booking, names and all. */
export const OWNERS_ADDRESS = "https://owner.example/bookings";
export const SOMEWHERE_ELSE = "https://elsewhere.example/bookings";

/** The password an invited person chooses for themselves. */
const CHOSEN_PASSWORD = "a-good-long-password";

/** The pages the story talks about, by the words it uses for them. Each is a
 * page an editor must never open. */
const PRIVATE_PAGES: Record<string, string> = {
  "list of attendees": "/admin/attendees",
  money: "/admin/ledger",
  people: "/admin/users",
  settings: "/admin/settings",
};

export const privatePagePath = (page: string): string =>
  requiredWorldValue(PRIVATE_PAGES[page], `a page called "${page}"`);

/** Everything the person is about to send has to be something they could
 * really type or pick on the page in front of them. */
const expectCanReallyType = (
  browser: TestBrowser,
  values: Record<string, string>,
): void => {
  for (const [box, typed] of Object.entries(values)) {
    expect(whyValueCannotBeSent(browser.currentHtml, box, typed)).toBeNull();
  }
};

/** Each admin page the editor is offered, paired with what the site answers
 * when they follow it. Only admin links are asked about — a link to the public
 * site or off it is nobody's to gate. */
export const pagesOfferedTo = async (
  browser: TestBrowser,
): Promise<Array<{ answered: number; href: string }>> => {
  const offered = [
    ...new Set(
      browser.links
        .map(({ href }) => href)
        .filter((href) => href.startsWith("/admin/")),
    ),
  ];
  const asked = [];
  for (const href of offered) {
    asked.push({ answered: await browser.statusOf(href), href });
  }
  return asked;
};

/** The owner invites somebody to edit, and copies the link they are given.
 * The role is chosen from the roles the form itself offers, so a form that
 * stopped offering "editor" fails here. */
export const ownerInvitesEditor = async (
  world: TicketsWorld,
  who: string,
): Promise<void> => {
  const browser = await adminBrowser(world);
  await browser.visit("/admin/user/new");
  // Both of the owner's choices have to be ones they could really make on the
  // page, or an invite could be crafted that no owner can send.
  expect(browser.pageText).toContain(t("fields.user.editor"));
  const chosen = { admin_level: "editor", username: who };
  expectCanReallyType(browser, chosen);
  await browser.submitForm(chosen, t("users.invite.submit"));
  // The owner reads the link off the page and passes it on, which is the only
  // way the invited person ever hears about it.
  const link = browser.pageText.match(/\/join\/[A-Za-z0-9_-]+/);
  if (!link) throw new Error(`The owner was given no link to send ${who}`);
  world.editorInvite = link[0];
};

/** The invited person opens their link, chooses a password, and is now an
 * editor with an account of their own. */
export const editorFollowsInvite = async (
  world: TicketsWorld,
): Promise<void> => {
  const browser = new TestBrowser();
  await browser.visit(requiredWorldValue(world.editorInvite, "the invite"));
  const chosen = {
    password: CHOSEN_PASSWORD,
    password_confirm: CHOSEN_PASSWORD,
  };
  expectCanReallyType(browser, chosen);
  await browser.submitForm(chosen, t("join.set_password.submit"));
  world.editorBrowser = browser;
};

/** The editor logs in the ordinary way, and stays logged in for the rest of
 * the story. */
export const editorLogsIn = async (
  world: TicketsWorld,
  who: string,
): Promise<void> => {
  const browser = new TestBrowser();
  await browser.visit("/admin/");
  const typed = { password: CHOSEN_PASSWORD, username: who };
  expectCanReallyType(browser, typed);
  await browser.submitForm(typed, t("login.submit"));
  world.editorBrowser = browser;
};

/** Somebody who is already an editor and already logged in. */
export const signedInEditor = async (
  world: TicketsWorld,
  who: string,
): Promise<void> => {
  if (world.editorBrowser) return;
  await ownerInvitesEditor(world, who);
  await editorFollowsInvite(world);
  await editorLogsIn(world, who);
};

/** The editor's own browser, once the story has signed them in. */
export const editorBrowser = (world: TicketsWorld): TestBrowser =>
  requiredWorldValue(world.editorBrowser, "the editor's browser");

/** Something the site already sells, kept under the name the story uses. */
export const somethingForSale = async (
  world: TicketsWorld,
  name: string,
  options: { forwardingTo?: string } = {},
): Promise<void> => {
  rememberStayListing(
    world,
    name,
    await createTestListing({
      maxAttendees: 10,
      name,
      webhookUrl: options.forwardingTo,
    }),
  );
};

/** What one sale of this thing brought in, in pounds and pence. A round figure
 * nothing else on the page would show by accident. */
export const TAKINGS = 37.5;

/** Somebody has bought this thing and paid for it, so the site has a real
 * figure to show — or to keep from an editor. */
export const somethingSoldAndPaidFor = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  await somethingForSale(world, name);
  const listing = stayListing(world, name);
  const buyer = await createTestAttendee(
    listing.id,
    listing.slug,
    "Buyer",
    "buyer@example.com",
  );
  await postListingSale({
    attendeeId: buyer.id,
    gross: toMinorUnits(TAKINGS),
    listingId: listing.id,
  });
};

/** What the owner sees on the same list of things for sale. Reading it proves
 * the figure is really there to leak before the story says the editor is not
 * shown it. */
export const ownersListingsPage = async (
  world: TicketsWorld,
): Promise<string> => {
  const browser = await adminBrowser(world);
  await browser.visit("/admin/listings");
  return browser.pageText;
};

/** The editor starts a new listing, picks what kind it is from the kinds the
 * site offers, fills the form in and saves it. */
export const editorAddsListing = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  const browser = editorBrowser(world);
  await browser.visit("/admin/listing/new");
  await browser.clickLink(t("listings_table.listing_type_picker_custom"));
  const typed = { max_attendees: "10", max_quantity: "1", name };
  expectCanReallyType(browser, typed);
  await browser.submitForm(typed, t("listings_table.create_listing"));
};

/** What the site sells under this name, or nothing when it sells no such
 * thing. */
export const listingSoldAsOrNull = async (
  name: string,
): Promise<ListingWithCount | null> =>
  (await getAllListings()).find((listing) => listing.name === name) ?? null;

/** Where a listing forwards its bookings now. */
export const forwardingAddress = async (
  world: TicketsWorld,
  name: string,
): Promise<string | null> => {
  const found = await getListingWithCount(stayListing(world, name).id);
  if (!found) throw new Error(`The ${name} is gone altogether`);
  return found.webhook_url;
};

/** The editor's save carries a forwarding address their form never offered.
 * That is the whole point of the attempt, so nothing is checked first — the
 * site has to be what turns it away, not the page. */
export const editorCraftsForwardingTo = async (
  world: TicketsWorld,
  name: string,
  address: string,
): Promise<void> => {
  const browser = editorBrowser(world);
  await savesListingForwarding(browser, world, name, address, {
    throughTheBox: false,
  });
  // The save itself has to have been accepted. A whole edit turned away would
  // leave the address alone too, and prove nothing about this one field.
  expect(browser.currentUrl).toBe(
    `/admin/listing/${stayListing(world, name).id}/edit`,
  );
  expect(browser.containsText("Listing updated")).toBe(true);
};

/** The owner makes the same change the ordinary way, through the box their own
 * form offers them. */
export const ownerSetsForwardingTo = async (
  world: TicketsWorld,
  name: string,
  address: string,
): Promise<void> => {
  await savesListingForwarding(
    await adminBrowser(world),
    world,
    name,
    address,
    {
      throughTheBox: true,
    },
  );
};

const savesListingForwarding = async (
  browser: TestBrowser,
  world: TicketsWorld,
  name: string,
  address: string,
  how: { throughTheBox: boolean },
): Promise<void> => {
  await browser.visit(`/admin/listing/${stayListing(world, name).id}/edit`);
  if (how.throughTheBox) {
    expect(
      whyValueCannotBeSent(browser.currentHtml, "webhook_url", address),
    ).toBeNull();
  }
  await browser.submitForm({ webhook_url: address }, "Save Changes");
};

/** The listing's edit form as the editor is served it. */
export const editorOpensListing = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  const browser = editorBrowser(world);
  await browser.visit(`/admin/listing/${stayListing(world, name).id}/edit`);
};

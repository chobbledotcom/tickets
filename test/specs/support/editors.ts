/**
 * An editor: somebody the owner lets write listings, and nothing else. Every
 * step here goes through the pages a real person would use — the owner's invite
 * form, the link it hands over, the login form, and the editor's own listing
 * pages — so a page that stopped working fails the story rather than being
 * stepped around.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { t } from "#i18n";
import { toMinorUnits } from "#shared/currency.ts";
import {
  getAllListings,
  getListingWithCount,
} from "#shared/db/listings/records.ts";
import type { ListingWithCount } from "#shared/types.ts";
import {
  browserSeenBy,
  EDITOR,
  type OpensAPage,
  openAdminPage,
  openAsNewcomer,
  opensPagesAs,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import {
  expectCanReallySend,
  fillInAndSend,
} from "#test/specs/support/form-controls.ts";
import {
  listingIdNamed,
  listingNamed,
  organiserSavesListing,
  rememberListing,
  saveListingEdit,
} from "#test/specs/support/listings.ts";

import {
  type ActOnOnePerson,
  type ActOnOneThing,
  type ChangeOneThing,
  requiredWorldValue,
  stillThere,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
// jscpd:ignore-end

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
export const ownerInvitesEditor: ActOnOnePerson = async (world, who) => {
  const browser = await openAdminPage(world, "/admin/user/new");
  // Both of the owner's choices have to be ones they could really make on the
  // page, or an invite could be crafted that no owner can send.
  expect(browser.pageText).toContain(t("fields.user.editor"));
  await fillInAndSend(
    browser,
    { admin_level: "editor", username: who },
    t("users.invite.submit"),
  );
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
  const browser = await openAsNewcomer(
    requiredWorldValue(world.editorInvite, "the invite"),
  );
  await fillInAndSend(
    browser,
    { password: CHOSEN_PASSWORD, password_confirm: CHOSEN_PASSWORD },
    t("join.set_password.submit"),
  );
  rememberBrowser(world, EDITOR, browser);
};

/** The editor logs in the ordinary way, and stays logged in for the rest of
 * the story. */
export const editorLogsIn: ActOnOnePerson = async (world, who) => {
  const browser = await openAsNewcomer("/admin/");
  await fillInAndSend(
    browser,
    { password: CHOSEN_PASSWORD, username: who },
    t("login.submit"),
  );
  rememberBrowser(world, EDITOR, browser);
};

/** Somebody who is already an editor and already logged in. Saying it twice of
 * the same person is fine; saying it of a second person is not, because only
 * one editor is ever signed in and every later step would quietly be taken by
 * the first one. */
export const signedInEditor: ActOnOnePerson = async (world, who) => {
  if (world.things.recall("browser", EDITOR)) {
    if (world.signedInEditorName !== who) {
      throw new Error(
        `${world.signedInEditorName} is already the signed-in editor, so ${who} cannot be as well`,
      );
    }
    return;
  }
  world.signedInEditorName = who;
  await ownerInvitesEditor(world, who);
  await editorFollowsInvite(world);
  await editorLogsIn(world, who);
};

/** The editor's own browser, once the story has signed them in. */
export const editorBrowser = (world: TicketsWorld): TestBrowser =>
  browserSeenBy(world, EDITOR);

/** The editor opens one of their own pages. */
const openAsEditor: OpensAPage = opensPagesAs(editorBrowser);

/** Something the site already sells, kept under the name the story uses. */
export const somethingForSale = async (
  world: TicketsWorld,
  name: string,
  options: { forwardingTo?: string } = {},
): Promise<void> => {
  rememberListing(
    world,
    name,
    await createTestListing({
      maxAttendees: 10,
      name,
      // The site's own thank-you page, so a story can read what a customer is
      // shown after booking rather than being sent off to another site.
      thankYouUrl: "",
      webhookUrl: options.forwardingTo,
    }),
  );
};

/** What one sale of this thing brought in, in pounds and pence. A round figure
 * nothing else on the page would show by accident. */
export const TAKINGS = 37.5;

/** Somebody has bought this thing and paid for it, so the site has a real
 * figure to show — or to keep from an editor. */
export const somethingSoldAndPaidFor: ActOnOneThing = async (world, name) => {
  await somethingForSale(world, name);
  const listing = listingNamed(world, name);
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
  const browser = await openAdminPage(world, "/admin/listings");
  return browser.pageText;
};

/** The editor starts a new listing, picks what kind it is from the kinds the
 * site offers, fills the form in and saves it. */
export const editorAddsListing: ActOnOneThing = async (world, name) => {
  const browser = await openAsEditor(world, "/admin/listing/new");
  await browser.clickLink(t("listings_table.listing_type_picker_custom"));
  const typed = { max_attendees: "10", max_quantity: "1", name };
  expectCanReallySend(browser.currentHtml, typed);
  await browser.submitForm(typed, t("listings_table.create_listing"));
};

/** What the site sells under this name, or nothing when it sells no such
 * thing. */
export const listingSoldAsOrNull = async (
  name: string,
): Promise<ListingWithCount | null> =>
  (await getAllListings()).find((listing) => listing.name === name) ?? null;

/** Where a listing forwards its bookings now, or nothing when it forwards them
 * nowhere. */
export const forwardingAddressOrNull = async (
  world: TicketsWorld,
  name: string,
): Promise<string | null> => {
  const found = await getListingWithCount(listingIdNamed(world, name));
  return stillThere(found, name).webhook_url;
};

/** The editor renames something the site already sells, through the listing's
 * own form. Changing a listing is their job, so this one goes through the box
 * the page offers them rather than being crafted. */
export const editorRenames: ChangeOneThing<string> = async (
  world,
  from,
  to,
) => {
  await saveListingEdit(
    editorBrowser(world),
    listingIdNamed(world, from),
    (served) => {
      expectCanReallySend(served, { name: to });
      return { name: to };
    },
  );
};

/** The editor's save carries a forwarding address their form never offered.
 * That is the whole point of the attempt, so nothing is checked first — the
 * site has to be what turns it away, not the page. */
export const editorCraftsForwardingTo: ChangeOneThing<string> = (
  world,
  name,
  address,
) =>
  // The save being accepted is what organiserSavesListing checks for us. A whole edit
  // turned away would leave the address alone too, and prove nothing about this
  // one field.
  saveListingEdit(editorBrowser(world), listingIdNamed(world, name), () => ({
    webhook_url: address,
  }));

/** The owner makes the same change the ordinary way, through the box their own
 * form offers them. */
export const ownerSetsForwardingTo: ChangeOneThing<string> = async (
  world,
  name,
  address,
) => {
  await organiserSavesListing(world, name, (served) => {
    expectCanReallySend(served, { webhook_url: address });
    return { webhook_url: address };
  });
};

/** The listing's edit form as the editor is served it. */
export const editorOpensListing: ActOnOneThing = async (world, name) => {
  await openAsEditor(
    world,
    `/admin/listing/${listingIdNamed(world, name)}/edit`,
  );
};

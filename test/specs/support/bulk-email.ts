/**
 * The owner writes to the people who booked: choosing who hears from them,
 * checking the message over, and sending it.
 *
 * Every way in is followed rather than built — the Email action on the listing's
 * own page, the compose form it opens, the Send button on the preview — so a
 * page that stops offering one of them fails the story instead of being stepped
 * around.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import { hashEmail, unsubscribeHash } from "#shared/db/contact-preferences.ts";
import { settings } from "#shared/db/settings.ts";
import {
  ORGANISER,
  openAdminPage,
  scenarioBrowser,
} from "#test/specs/support/browser.ts";
import { organiserAddsBooking } from "#test/specs/support/by-hand.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  listingIdNamed,
  rememberListing,
} from "#test/specs/support/listings.ts";
import {
  type PutsAWatchInPlace,
  watchesOutgoing,
} from "#test/specs/support/outgoing.ts";
import {
  keepWhatTheyWereTold,
  type ReadsWhatWasKept,
  requiredWorldValue,
  type TicketsWorld,
  whatWasKeptFor,
} from "#test/specs/support/world.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** Where pressing Send really goes. Asked of the page as well as posted to, so
 * a story can tell "the owner may send" from "the owner is shown a dead
 * button". */
const SEND_PATH = "/admin/emails/send";

/** Where the owner writes to a listing's attendees. */
const COMPOSE_PATH = "/admin/emails";

/** A message somebody writes: what it says, and whether it is a promotion
 * rather than news about something they booked. */
export interface MessageWritten {
  body: string;
  marketing?: boolean;
  subject: string;
}

/** The owner's own email provider. Without one the site still composes and
 * previews, but will not send in bulk. */
export const ownerHasAnEmailProvider = async (): Promise<void> => {
  await settings.update.email.provider("resend");
  await settings.update.email.apiKey("re_key");
  await settings.update.email.fromAddress("tickets@example.com");
};

/** Answer the email provider for one story, and remember every send. */
export const watchWhatIsSent: PutsAWatchInPlace = watchesOutgoing((url) =>
  url.includes("api.resend.com") ? new Response(null, { status: 200 }) : null,
);

/** Every send the site really made to the email provider. */
const sendsMade = (world: TicketsWorld) =>
  requiredWorldValue(world.messagesOut, "the outgoing watch").calls.filter(
    ({ url }) => url.includes("api.resend.com"),
  );

/** How many times the site went to the provider at all. A story proving a send
 * was refused asks this rather than reading the addresses: a send that went out
 * with nothing readable in it would otherwise look the same as no send. */
export const timesTheProviderWasAsked = (world: TicketsWorld): number =>
  sendsMade(world).length;

/** Every address the site really handed the provider, across every send. A send
 * carrying nothing readable is a broken watch or a broken payload rather than
 * an answer, so it fails loudly instead of reading as "nobody was written
 * to". */
export const addressesWrittenTo = (world: TicketsWorld): string[] =>
  sendsMade(world)
    .flatMap(({ body }) => (Array.isArray(body) ? body : [body]))
    .flatMap((one) => {
      const to = (one as { to?: unknown } | null)?.to;
      if (!Array.isArray(to) || to.some((who) => typeof who !== "string")) {
        throw new Error(
          `The site sent to the provider with no readable addresses: ${JSON.stringify(one)}`,
        );
      }
      return to as string[];
    });

/** People booked onto a listing the story names, each through the form on that
 * listing's own roster. Their addresses are kept under the listing's name, so a
 * later step can check exactly who was written to rather than counting. An
 * address of "" is somebody who left none. */
export const peopleBookOnto = async (
  world: TicketsWorld,
  listingName: string,
  addresses: string[],
): Promise<void> => {
  const listing = await createTestListing({
    maxAttendees: 50,
    name: listingName,
  });
  rememberListing(world, listingName, listing);
  for (const [index, email] of addresses.entries()) {
    await organiserAddsBooking(world, listingName, {
      email,
      who: `Booker ${index + 1}`,
    });
  }
  world.things.remember(
    "booked",
    listingName,
    addresses.filter((email) => email !== ""),
  );
};

/** The addresses of everyone the story booked onto one listing. */
export const bookedOnto: ReadsWhatWasKept<"booked"> = whatWasKeptFor("booked");

/** Somebody tells the site they would rather not hear about promotions. */
export const asksNotToHearAboutPromotions = async (
  email: string,
): Promise<void> => {
  await unsubscribeHash(await hashEmail(email));
};

/** The way in to writing to one listing's attendees, off that listing's own
 * page, or nothing when the page offers none. Found by where the link goes
 * rather than by its words: the admin pages carry more than one link reading
 * "Email", and one of the others leads off to the settings page. */
const wayInToEmailing = async (
  world: TicketsWorld,
  listingName: string,
): Promise<{ browser: TestBrowser; wayIn: string | undefined }> => {
  const listingId = listingIdNamed(world, listingName);
  const browser = await openAdminPage(
    world,
    `/admin/listing/${listingId}/actions`,
  );
  const writesToTheseAttendees = `${COMPOSE_PATH}?listing=${listingId}`;
  return {
    browser,
    wayIn: browser.links.find(({ href }) => href === writesToTheseAttendees)
      ?.href,
  };
};

/** The owner opens the page for writing to one listing's attendees, following
 * the way in on that listing's own page. A listing offering no way in is one
 * nobody could write from, so the story fails with them. */
export const opensEmailForListing = async (
  world: TicketsWorld,
  listingName: string,
): Promise<TestBrowser> => {
  const { browser, wayIn } = await wayInToEmailing(world, listingName);
  if (!wayIn) {
    throw new Error(`"${listingName}" offers no way to write to its attendees`);
  }
  await browser.visit(wayIn);
  return browser;
};

/** Whether the listing's own page offers the owner any way to write to the
 * people booked onto it. */
export const listingOffersEmailAction = async (
  world: TicketsWorld,
  listingName: string,
): Promise<boolean> =>
  (await wayInToEmailing(world, listingName)).wayIn !== undefined;

/** The owner writes their message on the compose page they are looking at, and
 * asks to see it before it goes. */
export const writesAndAsksToSee = async (
  world: TicketsWorld,
  browser: TestBrowser,
  message: MessageWritten,
): Promise<void> => {
  await fillInAndSend(
    browser,
    { body: message.body, subject: message.subject },
    t("bulk_email.preview_button"),
    message.marketing ? { marketing: ["1"] } : { marketing: [] },
  );
  world.wordsWritten = message.body;
  keepWhatTheyWereTold(world, ORGANISER, browser.pageText);
};

/** The words the owner wrote, so a later step can look for those rather than
 * for words repeated in the step itself. */
export const wordsTheyWrote = (world: TicketsWorld): string =>
  requiredWorldValue(world.wordsWritten, "the words the owner wrote");

/** The owner writes to one listing's attendees, all the way from that listing's
 * own page to the preview they end up on. */
export const writesToListing = async (
  world: TicketsWorld,
  listingName: string,
  message: MessageWritten,
): Promise<void> => {
  await writesAndAsksToSee(
    world,
    await opensEmailForListing(world, listingName),
    message,
  );
};

/** Whether the preview the owner is looking at offers to have the site send
 * the message for them. A page whose only Send button is switched off offers
 * nothing, however present the button looks. */
export const siteOffersToSend = (world: TicketsWorld): boolean =>
  scenarioBrowser(world).offersAWayToPost(SEND_PATH);

/** Whether the preview still offers to open the message as a draft in the
 * owner's own email app. This is offered whether or not the site can send for
 * them, so "the site will not send this" is never the same as "there is no way
 * to send this at all". */
export const previewOffersADraftToSendThemselves = (
  world: TicketsWorld,
): boolean =>
  scenarioBrowser(world).links.some(({ href }) => href.startsWith("mailto:"));

/** The owner presses Send on the preview they are looking at, and is left with
 * whatever the site told them. */
export const sendsWhatWasPreviewed = async (
  world: TicketsWorld,
): Promise<void> => {
  const browser = scenarioBrowser(world);
  await browser.submitFormAt(SEND_PATH);
  keepWhatTheyWereTold(world, ORGANISER, browser.pageText);
};

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
  keepWhatTheyWereTold,
  type ReadsWhatWasKept,
  requiredWorldValue,
  type TicketsWorld,
  whatWasKeptFor,
} from "#test/specs/support/world.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { installRecordingFetch } from "#test-utils/mocks.ts";
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

/** Answer the email provider for one story, and remember every send. Put back
 * when the scenario ends, so one story's stand-in cannot reach the next. */
export const watchWhatIsSent = (world: TicketsWorld): void => {
  const watching = installRecordingFetch((url) =>
    url.includes("api.resend.com") ? new Response(null, { status: 200 }) : null,
  );
  world.cleanup.add(watching.restore);
  world.messagesOut = watching;
};

/** Every address the site really handed the provider, across every send. */
export const addressesWrittenTo = (world: TicketsWorld): string[] => {
  const watching = requiredWorldValue(world.messagesOut, "the outgoing watch");
  return watching.calls
    .filter(({ url }) => url.includes("api.resend.com"))
    .flatMap(({ body }) => (Array.isArray(body) ? body : [body]))
    .flatMap((one) => (one as { to?: string[] } | null)?.to ?? []);
};

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

/** Whether the preview the owner is looking at offers them any way to send. A
 * page whose only Send button is switched off offers none. */
export const previewOffersASend = (world: TicketsWorld): boolean =>
  scenarioBrowser(world).offersAWayToPost(SEND_PATH);

/** The owner presses Send on the preview they are looking at, and is left with
 * whatever the site told them. */
export const sendsWhatWasPreviewed = async (
  world: TicketsWorld,
): Promise<void> => {
  const browser = scenarioBrowser(world);
  await browser.submitFormAt(SEND_PATH);
  keepWhatTheyWereTold(world, ORGANISER, browser.pageText);
};

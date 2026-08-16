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
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
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
import { dayFromToday, openStayListing } from "#test/specs/support/stays.ts";
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

/** Every payload entry the provider was handed, across every send — one
 * person's copy each for providers that send per recipient. */
const copiesHanded = (world: TicketsWorld): unknown[] =>
  sendsMade(world).flatMap(({ body }) => (Array.isArray(body) ? body : [body]));

/** The `to` list one payload entry carries, or nothing when it has none. */
const addressesOn = (one: unknown): unknown =>
  (one as { to?: unknown } | null)?.to;

/** Every address the site really handed the provider, across every send. A send
 * carrying nothing readable is a broken watch or a broken payload rather than
 * an answer, so it fails loudly instead of reading as "nobody was written
 * to". */
export const addressesWrittenTo = (world: TicketsWorld): string[] =>
  copiesHanded(world).flatMap((one) => {
    const to = addressesOn(one);
    if (!Array.isArray(to) || to.some((who) => typeof who !== "string")) {
      throw new Error(
        `The site sent to the provider with no readable addresses: ${JSON.stringify(one)}`,
      );
    }
    return to as string[];
  });

/** One person's copy of what was really sent: the payload entry the provider
 * was handed for that address. A story reading a link out of an email fails
 * loudly when that person was sent nothing, or when their copy carries no
 * readable body. */
export const whatWasSentTo = (
  world: TicketsWorld,
  email: string,
): { html: string } => {
  const copy = copiesHanded(world).find((one) => {
    const to = addressesOn(one);
    return Array.isArray(to) && to.includes(email);
  });
  const html = (copy as { html?: unknown } | undefined)?.html;
  if (typeof html !== "string" || html === "") {
    throw new Error(`Nothing readable was sent to ${email}`);
  }
  return { html };
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

/** The address the story gives somebody it names, so a later step can check who
 * the site really wrote to without the story repeating an address. */
export const addressOf = (who: string): string =>
  `${who.toLowerCase()}@example.com`;

/** A listing booked by the day, made once per story and remembered by name, so
 * two people can book different days of the same thing. Room for a stay of up
 * to a week covers both a single day and a booking spanning several. */
const dailyListingNamed = async (
  world: TicketsWorld,
  listingName: string,
): Promise<void> => {
  if (world.things.recall("listing", listingName)) return;
  await openStayListing(world, listingName, 7, 50, { customerPicksDays: true });
};

/** Somebody books one listing from a day, for however many days they stay. The
 * organiser adds it through the roster form, so a story never books past a way
 * in the site does not offer. */
export const personBooksDays = async (
  world: TicketsWorld,
  who: string,
  listingName: string,
  firstDay: number,
  dayCount: number,
): Promise<void> => {
  if (!world.messagesOut) watchWhatIsSent(world);
  await dailyListingNamed(world, listingName);
  await organiserAddsBooking(world, listingName, {
    day: dayFromToday(world, firstDay),
    dayCount,
    email: addressOf(who),
    who,
  });
};

/** The owner opens the page for writing to one day of a listing, following the
 * way in on that day's own attendee list. A day offering no way in is one
 * nobody could write from, so the story fails with it. */
export const opensEmailForListingDay = async (
  world: TicketsWorld,
  listingName: string,
  day: number,
): Promise<TestBrowser> => {
  const listingId = listingIdNamed(world, listingName);
  const date = dayFromToday(world, day);
  const browser = await openAdminPage(
    world,
    `/admin/listing/${listingId}/attendees?date=${date}`,
  );
  const wayIn = `${COMPOSE_PATH}?listing=${listingId}&day=${date}`;
  if (!browser.links.some(({ href }) => href === wayIn)) {
    throw new Error(`${listingName} offers no way to write to ${date}`);
  }
  await browser.visit(wayIn);
  // The compose page names the one day it is aimed at, which is the whole
  // claim: a term booked date by date can be addressed a date at a time.
  leaveEvidencePage(world, ["one-days-audience"], wayIn);
  return browser;
};

/** The owner writes on whichever compose page they reached, and asks to see it
 * before it goes. Every way in differs only in the page it opens, so the
 * writing itself is described once. */
const writesOnPageFrom = async (
  world: TicketsWorld,
  opening: Promise<TestBrowser>,
  message: MessageWritten,
): Promise<void> => {
  await writesAndAsksToSee(world, await opening, message);
};

/** The owner writes to one day of a listing and asks to see it before it goes. */
export const writesToListingDay = (
  world: TicketsWorld,
  listingName: string,
  day: number,
  message: MessageWritten,
): Promise<void> =>
  writesOnPageFrom(
    world,
    opensEmailForListingDay(world, listingName, day),
    message,
  );

/** The addresses of everyone the story booked onto one listing. */
export const bookedOnto: ReadsWhatWasKept<"booked"> = whatWasKeptFor("booked");

/** The addresses the stories give the people they book, in booking order.
 * Kept here so every scenario books the same people and a later step — in
 * this story or the reader's own — can name one of them. */
export const BOOKERS = ["first@example.com", "second@example.com"];

export const bookersFor = (howMany: number): string[] => {
  // Quietly booking fewer people than the story asked for would make every
  // count below it right for the wrong reason.
  if (howMany > BOOKERS.length) {
    throw new Error(
      `Only ${BOOKERS.length} people can be booked, the story asked for ${howMany}`,
    );
  }
  return BOOKERS.slice(0, howMany);
};

/** The first person a story booked is the one who acts on their own copy, so
 * "one of them" and "they" mean the same person however many were booked. */
export const theOneWhoAsked = (): string => BOOKERS[0]!;

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
export const writesToListing = (
  world: TicketsWorld,
  listingName: string,
  message: MessageWritten,
): Promise<void> =>
  writesOnPageFrom(world, opensEmailForListing(world, listingName), message);

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

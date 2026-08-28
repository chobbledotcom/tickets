/**
 * The organiser texting one person who booked. Texts leave through a gateway
 * the owner runs on a phone of their own, so every scenario here either sets
 * that gateway up or deliberately leaves it out.
 */

// jscpd:ignore-start

import { getContactRecord, hashPhone } from "#db/contact-preferences.ts";
import { settings } from "#db/settings.ts";
import { countSmsMessages } from "#db/sms-messages.ts";
import { somebodyBooksThroughTheSite } from "#test/specs/support/booking-setup.ts";
import {
  adminPageHtmlAt,
  organiserReads,
  writesOneMessage,
} from "#test/specs/support/browser.ts";
import { copyFrom } from "#test/specs/support/copy.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

// jscpd:ignore-end

const TEXTS_PATH = "/admin/sms";

/** What the site says on the texting pages. */
export const textingCopy = copyFrom("sms");

/** The number one person books with. Each person gets their own, counted off
 * as they book, so a story about two people cannot read one of them and
 * answer for the other. These are the numbers Ofcom keeps for drama, so none
 * of them can reach a real phone. */
const phoneGivenBy = (alreadyBooked: number): string =>
  `+447700900${123 + alreadyBooked}`;

/** The number one named person gave, or nothing when they gave none. */
export const phoneOf = (world: TicketsWorld, who: string): string =>
  bookingOf(world, who).phone;

/** The gateway credentials, which are the phone app's own — nothing to do
 * with signing in here. */
export const gatewayIsSetUp = async (): Promise<void> => {
  await settings.update.smsGatewayPassphrase("a-long-enough-passphrase");
  await settings.update.smsGatewayUsername("phone-app-user");
  await settings.update.smsGatewayPassword("phone-app-password");
};

/** Losing the end-to-end key is enough: without it nothing can be encrypted
 * for the phone, so the site reads the gateway as gone. */
export const gatewayIsSwitchedOff = (): Promise<void> =>
  settings.update.smsGatewayPassphrase("");

/** What the story set up for one named person, or a loud failure. Every step
 * that names somebody reaches their booking through here, so a story naming a
 * person it never booked says so rather than acting on somebody else. */
const bookingOf = (world: TicketsWorld, who: string) =>
  world.things.require("booking", who);

/** Somebody books through the real public page, so the number under test is
 * one a visitor really typed rather than a row put straight into the table.
 * Their booking is kept under their own name, because a story that texts one
 * of two people has to reach that one. */
export const somebodyBooks = async (
  world: TicketsWorld,
  who: string,
  listingName: string,
  givingAPhone: boolean,
): Promise<void> => {
  const phone = givingAPhone
    ? phoneGivenBy(world.things.names("booking").length)
    : "";
  const { attendeeId, listing } = await somebodyBooksThroughTheSite(world, {
    email: `${who.toLowerCase()}@example.com`,
    listingName,
    who,
    ...(phone ? { phone } : {}),
  });
  world.things.remember("booking", who, {
    attendeeId,
    listingId: listing.id,
    phone,
  });
};

/** One named person's own texting page. */
export const textsPathFor = (world: TicketsWorld, who: string): string => {
  const { attendeeId, listingId } = bookingOf(world, who);
  return `${TEXTS_PATH}?listing=${listingId}&attendee=${attendeeId}`;
};

/** One named person's page: the compose form, and what has been said to
 * them. */
export const organiserOpensSomebodysTexts = organiserReads(textsPathFor);

/** The page with nobody chosen: the queue, and no way to write. */
export const organiserOpensTheTextsPage = organiserReads(TEXTS_PATH);

/** What the gateway will answer this scenario. Recorded rather than stubbed
 * here: the send is the only moment a reply is needed, and stubbing twice
 * would leave the second stub answering for the first. */
export const gatewayWillAnswer = (
  world: TicketsWorld,
  reply: () => Response,
): void => {
  world.gatewayReply = reply;
};

/** Send through the gateway with whatever this scenario said it answers. The
 * stub stands only for the one send, so a story that texts twice raises a
 * fresh one each time rather than stubbing over its own. */
export const throughTheGateway = async <T>(
  world: TicketsWorld,
  send: () => Promise<T>,
): Promise<T> => {
  const answer = world.gatewayReply ?? (() => new Response('{"id":"msg-9"}'));
  using _gateway = stubFetch(answer());
  return await send();
};

const writesAText = writesOneMessage(textsPathFor, () =>
  textingCopy("sms.contact.send"),
);

/** The organiser writes and sends a text to one named person, with the gateway
 * standing in for the phone that would carry it. */
export const organiserTexts = (
  world: TicketsWorld,
  who: string,
  message: string,
): Promise<void> =>
  throughTheGateway(world, () => writesAText(world, message, who));

/** The message history as the organiser reads it, on that person's own page.
 * Reading the log instead would keep the story green after the page stopped
 * showing history at all, which is the very thing one of these scenarios
 * exists to prove. Their own page rather than the last one opened, so a story
 * about two people can read the one it did not just text. */
export const historyShownTo = async (
  world: TicketsWorld,
  who: string,
): Promise<string> => {
  const page = await adminPageHtmlAt(world, textsPathFor(world, who));
  const start = page.indexOf(await textingCopy("sms.contact.history_heading"));
  if (start < 0) throw new Error(`${who}'s page shows no message history`);
  return page.slice(start);
};

/** How many messages are waiting to go, read from the queue itself. The log
 * saying nothing went is not the same as nothing being queued. */
export const messagesQueued = (): Promise<number> => countSmsMessages();

/** What the site has kept against the number one named person booked with:
 * how many messages, and the last thing said. Read through the site's own
 * contact record, which is what the organiser reads on their history page. */
export const recordAgainstPhone = async (
  world: TicketsWorld,
  who: string,
): Promise<{ counted: number; lastSaid: string }> => {
  const record = await getContactRecord(
    await hashPhone(phoneOf(world, who)),
    await getTestPrivateKey(),
  );
  return { counted: record.contactCount, lastSaid: record.lastSubject };
};

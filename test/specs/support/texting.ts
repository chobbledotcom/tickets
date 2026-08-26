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
  ORGANISER,
  organiserReads,
  writesOneMessage,
} from "#test/specs/support/browser.ts";
import { copyFrom } from "#test/specs/support/copy.ts";
import { soleBookingOn } from "#test/specs/support/public-booking.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

// jscpd:ignore-end

const TEXTS_PATH = "/admin/sms";

/** Where the history begins on the page, so a message found in the compose
 * box or a flash cannot answer for one in the history. */
const HISTORY_HEADING = "Message history";

/** What the site says on the texting pages. */
export const textingCopy = copyFrom("sms");

/** The number the story's person books with. Its own constant so the step
 * that reads it back off the page cannot drift from the one that gave it. */
export const PHONE_GIVEN = "+447700900123";

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

/** Somebody books through the real public page, so the number under test is
 * one a visitor really typed rather than a row put straight into the table. */
export const somebodyBooks = async (
  world: TicketsWorld,
  who: string,
  listingName: string,
  givingAPhone: boolean,
): Promise<void> => {
  const listing = await somebodyBooksThroughTheSite(world, {
    email: `${who.toLowerCase()}@example.com`,
    listingName,
    who,
    ...(givingAPhone ? { phone: PHONE_GIVEN } : {}),
  });
  world.listingId = listing.id;
  world.attendeeId = await soleBookingOn(listing.id);
};

export const textsPathFor = (world: TicketsWorld): string =>
  `${TEXTS_PATH}?listing=${world.listingId}&attendee=${world.attendeeId}`;

/** One person's page: the compose form, and what has been said to them. */
export const organiserOpensSomebodysTexts = organiserReads(textsPathFor);

/** The page with nobody chosen: the queue, and no way to write. */
export const organiserOpensTheTextsPage = organiserReads(() => TEXTS_PATH);

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

/** The organiser writes and sends a text, with the gateway standing in for
 * the phone that would carry it. */
export const organiserTexts = (
  world: TicketsWorld,
  message: string,
): Promise<void> => throughTheGateway(world, () => writesAText(world, message));

/** The message history as the organiser reads it, off the page they are
 * looking at. Reading the log instead would keep the story green after the
 * page stopped showing history at all, which is the very thing one of these
 * scenarios exists to prove. */
export const historyShownTo = (world: TicketsWorld): string => {
  const page = whatTheyWereTold(world, ORGANISER);
  const start = page.indexOf(HISTORY_HEADING);
  if (start < 0) throw new Error("The page shows no message history");
  return page.slice(start);
};

/** How many messages are waiting to go, read from the queue itself. The log
 * saying nothing went is not the same as nothing being queued. */
export const messagesQueued = (): Promise<number> => countSmsMessages();

/** How many messages the site has counted against the number they booked
 * with. Read through the site's own contact record, which is what the
 * organiser reads on the person's history page. */
export const messagesCountedAgainstPhone = async (): Promise<number> =>
  (
    await getContactRecord(
      await hashPhone(PHONE_GIVEN),
      await getTestPrivateKey(),
    )
  ).contactCount;

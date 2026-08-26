/**
 * The organiser texting one person who booked. Texts leave through a gateway
 * the owner runs on a phone of their own, so every scenario here either sets
 * that gateway up or deliberately leaves it out.
 */

// jscpd:ignore-start

import { getContactRecord, hashPhone } from "#db/contact-preferences.ts";
import { settings } from "#db/settings.ts";
import { somebodyBooksThroughTheSite } from "#test/specs/support/booking-setup.ts";
import {
  adminPageHtmlAt,
  ORGANISER,
  writesOneMessage,
} from "#test/specs/support/browser.ts";
import { copyFrom } from "#test/specs/support/copy.ts";
import { soleBookingOn } from "#test/specs/support/public-booking.ts";
import {
  keepWhatTheyWereTold,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { getAttendeeActivityLog } from "#test-utils/activity-log.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";

// jscpd:ignore-end

const TEXTS_PATH = "/admin/sms";

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

/** The organiser opens a texting page and keeps what it said, so the Then
 * steps read the same page the When opened. Curried on which page, because
 * the queue page and one person's page differ only in their address. */
const organiserOpens =
  (where: (world: TicketsWorld) => string) =>
  async (world: TicketsWorld): Promise<void> => {
    keepWhatTheyWereTold(
      world,
      ORGANISER,
      await adminPageHtmlAt(world, where(world)),
    );
  };

/** One person's page: the compose form, and what has been said to them. */
export const organiserOpensSomebodysTexts = organiserOpens(textsPathFor);

/** The page with nobody chosen: the queue, and no way to write. */
export const organiserOpensTheTextsPage = organiserOpens(() => TEXTS_PATH);

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

/** Everything one person's message history holds, newest first. */
export const historyFor = async (world: TicketsWorld): Promise<string[]> =>
  (await getAttendeeActivityLog(requiredAttendee(world))).map(
    (entry) => entry.message,
  );

const requiredAttendee = (world: TicketsWorld): number => {
  const id = world.attendeeId;
  if (id === undefined) throw new Error("Nobody has booked in this story yet");
  return id;
};

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

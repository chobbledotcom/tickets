/**
 * A scanner: somebody the owner lets work a door, and nothing else. Every step
 * here goes through the pages a real person would use — the owner's invite
 * form, the link it hands over, the login form, the doors list, and the door
 * pages themselves — so a page that stopped working fails the story rather
 * than being stepped around.
 */

// jscpd:ignore-start
import {
  browserSeenBy,
  SCANNER,
  visiting,
} from "#test/specs/support/browser.ts";
import {
  type ShowTicketAtDoor,
  sendDoorScan,
} from "#test/specs/support/door.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import { invitedRoleJourney } from "#test/specs/support/staff-accounts.ts";
import type {
  ActOnOnePerson,
  ActOnTheStory,
  TicketsWorld,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The scanner's account journey, shared with every other invited role: the
 * owner invites them, they follow their link and choose a password, they sign
 * in, and their pages run in a browser of their own. The role is chosen from
 * the roles the invite form itself offers, so a form that stopped offering
 * "scanner" fails here. */
const journey = invitedRoleJourney({
  browserName: SCANNER,
  inviteName: "the scanner invite",
  role: "scanner",
});

export const ownerInvitesScanner: ActOnOnePerson = journey.invites;

/** The invited person opens their link and chooses a password. The browser
 * that holds the single-use invitation visit is kept under the scanner's
 * name, and the next step signs in from a fresh page of their own. */
export const scannerFollowsInvite: ActOnTheStory = journey.followsInvite;

/** The scanner logs in the ordinary way, and stays logged in for the rest of
 * the story. */
export const scannerLogsIn: ActOnOnePerson = journey.logsIn;

/** Somebody who is already a scanner and already logged in. */
export const signedInScanner: ActOnOnePerson = journey.signedIn;

/** The scanner's own browser, once the story has signed them in. */
export const scannerBrowser = (world: TicketsWorld): TestBrowser =>
  browserSeenBy(world, SCANNER);

/** The scanner opens one page in their own signed-in browser. */
export const openScannerPage = (
  world: TicketsWorld,
  path: string,
): Promise<TestBrowser> => visiting(scannerBrowser(world), path);

/** The door's scanner page for one listing, opened by the scanner. */
export const openScannerDoor = async (
  world: TicketsWorld,
  listing: string,
): Promise<TestBrowser> =>
  openScannerPage(
    world,
    `/admin/listing/${listingIdNamed(world, listing)}/scanner`,
  );

/** One scan the scanner's own door page would send: the page is opened first
 * so the code and cookies are the scanner's own. */
export const scanAtDoorAsScanner: ShowTicketAtDoor = async (
  world,
  listing,
  ticket,
  choices = {},
) => {
  const browser = await openScannerDoor(world, listing);
  return await sendDoorScan(
    `/admin/listing/${listingIdNamed(world, listing)}/scan`,
    browser,
    ticket,
    choices,
  );
};

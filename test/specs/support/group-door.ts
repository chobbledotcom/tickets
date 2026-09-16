/**
 * Checking people in at a group's door. The organiser works from the group's
 * scanner page: one door for every member listing of the group. Every check
 * here goes through that page — the page is opened first, and the code it
 * carries for the request is the one the page itself supplies, so a group
 * scanner page that stopped working would fail the story rather than being
 * stepped around.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import { openAdminPage } from "#test/specs/support/browser.ts";
import {
  type DoorPaths,
  offeredAt,
  rememberTicket,
  scanAt,
} from "#test/specs/support/door.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  listingIdNamed,
  rememberListing,
} from "#test/specs/support/listings.ts";
import {
  type ReadAboutOneThing,
  type TicketsWorld,
  whatWasKeptFor,
} from "#test/specs/support/world.ts";
import {
  createMultiBookingAttendee,
  createTestAttendeeDirect,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

// jscpd:ignore-end

/** The world's group doors, keyed by the name the story calls the group. */
const doorIdNamed = whatWasKeptFor("group_door");

/** One group door's own pages: its scanner, and the door it answers. */
const groupDoorPaths = (world: TicketsWorld, groupName: string): DoorPaths => {
  const id = doorIdNamed(world, groupName);
  return {
    page: `/admin/groups/${id}/scanner`,
    scan: `/admin/groups/${id}/scan`,
  };
};

/** A fixture over the group's tiers: the world, the name the story calls the
 * thing being set up, and the tiers it covers. */
type TierStep = (
  world: TicketsWorld,
  name: string,
  tiers: string[],
) => Promise<void>;

/** Build a group with one scanner door and the member listings the story
 * calls its tiers. */
export const groupDoorWithTiers: TierStep = async (world, groupName, tiers) => {
  const group = await createTestGroup({ name: groupName });
  world.things.remember("group_door", groupName, group.id);
  for (const tier of tiers) {
    rememberListing(
      world,
      tier,
      await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: tier,
      }),
    );
  }
};

/** Someone with a ticket for one tier of the group. */
export const personWithTierTicket = async (
  world: TicketsWorld,
  who: string,
  tier: string,
): Promise<void> => {
  const { token } = await createTestAttendeeDirect(
    listingIdNamed(world, tier),
    who,
    `${who.toLowerCase()}@example.com`,
  );
  rememberTicket(world, who, token);
};

/** Someone with one ticket that covers several of the group's tiers. */
export const personWithMultiTierTicket = async (
  world: TicketsWorld,
  who: string,
  tiers: string[],
): Promise<void> => {
  const attendee = await createMultiBookingAttendee(
    who,
    `${who.toLowerCase()}@example.com`,
    tiers.map((tier) => ({ listingId: listingIdNamed(world, tier) })),
  );
  rememberTicket(world, who, attendee.ticket_token);
};

/** The organiser holds a ticket up to a group's door and is told what to do
 * with the person in front of them, with whatever they decided about a
 * ticket the door queried. */
export const showTicketAtGroupDoor = scanAt(groupDoorPaths);

/** The whole group door page, for checks about what is not on it at all. */
export const groupDoorPageHtml: ReadAboutOneThing = async (world, groupName) =>
  (await openAdminPage(world, groupDoorPaths(world, groupName).page))
    .currentHtml;

/** The people the group's own scanner offers when the organiser looks someone
 * up by hand instead of reading their ticket. */
export const peopleOfferedAtGroupDoor = offeredAt(groupDoorPageHtml);

/** Turn the group's own "check in every listing when scanning" box on,
 * through the very form the scanner page renders. */
export const groupDoorChecksInAll = async (
  world: TicketsWorld,
  groupName: string,
): Promise<void> => {
  const browser = await openAdminPage(
    world,
    groupDoorPaths(world, groupName).page,
  );
  await fillInAndSend(browser, {}, t("admin.scanner.save_setting"), {
    scan_checks_in_all_listings: ["1"],
  });
};

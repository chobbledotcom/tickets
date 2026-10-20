/**
 * The door's saved tickets. Before the connection goes, a door saves the
 * day's tickets as one-way codes; while the connection is gone it answers a
 * scan from that list, and when the connection returns it delivers the
 * check-ins it saved. Every request here goes through the door's own scanner
 * page — its cookies, and its one-use code where the request changes
 * something — the same way the page's own script sends them.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import * as v from "valibot";
import { sha256Hex } from "#crypto/sha256.ts";
import { getAttendeesByTokens } from "#db/attendees/tokens.ts";
import { handleRequest } from "#routes";
import { expectAccepted, openAdminPage } from "#test/specs/support/browser.ts";
import {
  cookiesOf,
  type DoorAnswer,
  doorScanRequest,
  type DoorPaths,
  listingPath,
  readDoorAnswer,
  ticketOf,
} from "#test/specs/support/door.ts";
import { groupDoorPaths } from "#test/specs/support/group-door.ts";
import {
  type TicketsWorld,
  whatWasKeptFor,
} from "#test/specs/support/world.ts";
import { storedCheckinRows } from "#test-utils/db-helpers/checkin-rows.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** One door's saved list, read back by the name the story calls the door. */
const savedCodesAt = whatWasKeptFor("saved_codes");

/** The body a door's save answers: the sorted one-way codes, and nothing
 * else — no ticket in full, and no guest detail. */
const savedListBody = v.object({ hashes: v.array(v.string()) });

/** The one-way code of one person's ticket — the only form of the ticket a
 * door's saved list holds. */
const codeFor = (world: TicketsWorld, who: string): Promise<string> =>
  sha256Hex(ticketOf(world, who));

/** One GET of a door's saved list with one browser's cookies. The read
 * changes nothing, so it carries no one-use code. */
const listRequest = (path: string, browser: TestBrowser): Request =>
  new Request(`http://localhost${path}`, {
    headers: { cookie: cookiesOf(browser), host: "localhost" },
  });

/** Save one door's list the way the door's own page saves it on load. The
 * list is kept under the door's name, raw body and all, so the story can
 * check what travelled. */
const saveDoorCodes = async (
  world: TicketsWorld,
  doorName: string,
  pagePath: string,
  savePath: string,
): Promise<void> => {
  const browser = await openAdminPage(world, pagePath);
  const response = await handleRequest(listRequest(savePath, browser));
  const body = await expectAccepted(response).text();
  const hashes = v.parse(savedListBody, JSON.parse(body)).hashes;
  world.things.remember("saved_codes", doorName, { body, hashes });
};

/** Save the listing door's list, named the way the story names the listing. */
export const saveListingDoorCodes = (
  world: TicketsWorld,
  listing: string,
): Promise<void> =>
  saveDoorCodes(
    world,
    listing,
    listingPath(world, listing, "scanner"),
    listingPath(world, listing, "scan-tokens"),
  );

/** Save the group door's list, named the way the story names the group. */
export const saveGroupDoorCodes = (
  world: TicketsWorld,
  groupName: string,
): Promise<void> =>
  saveDoorCodes(
    world,
    groupName,
    groupDoorPaths(world, groupName).page,
    `${groupDoorPaths(world, groupName).scan}-tokens`,
  );

/** Reach for one listing door's list in one browser, and answer the status
 * the site answers with — the way somebody without door duties reaches for
 * it, or the way a door with no door behind it is asked. */
export const trySavingListingDoorCodes = async (
  world: TicketsWorld,
  browser: TestBrowser,
  listing: string,
): Promise<number> =>
  (
    await handleRequest(
      listRequest(listingPath(world, listing, "scan-tokens"), browser),
    )
  ).status;

/** One saved check-in: the code the door stored, and the delivery id the
 * device made up for it. The id is what makes the delivery's retry land
 * nowhere: the same delivery twice admits once. The retry sends the same
 * request the first send made, quantity pick included. */
export type SavedDelivery = {
  code: string;
  operationId: string;
  places?: number;
};

/** Send one saved delivery to a door, through the door's own scanner page.
 * The answer the door reads comes back whatever the site answered: a
 * check-in the site cannot match arrives as 404 with the door's own JSON
 * body, and the story reads the body. */
const postSavedDelivery = async (
  world: TicketsWorld,
  paths: DoorPaths,
  delivery: SavedDelivery,
): Promise<DoorAnswer> => {
  const browser = await openAdminPage(world, paths.page);
  const response = await handleRequest(
    doorScanRequest(paths.scan, browser, {
      operation_id: delivery.operationId,
      token_hash: delivery.code,
      ...(delivery.places === undefined ? {} : { quantity: delivery.places }),
    }),
  );
  return readDoorAnswer(response);
};

/** Deliver one saved check-in at a door. The code must be on the list of the
 * door the story names, so a delivery no door saved fails here rather than
 * testing nothing. */
const deliverSavedCheckIn = async (
  world: TicketsWorld,
  paths: DoorPaths,
  listDoorName: string,
  who: string,
  places?: number,
): Promise<DoorAnswer> => {
  const code = await codeFor(world, who);
  if (!savedCodesAt(world, listDoorName).hashes.includes(code)) {
    throw new Error(
      `${listDoorName} saved no one-way code for ${who}'s ticket`,
    );
  }
  const delivery: SavedDelivery = {
    code,
    operationId: crypto.randomUUID(),
    ...(places === undefined ? {} : { places }),
  };
  world.things.remember("saved_delivery", "last", delivery);
  return postSavedDelivery(world, paths, delivery);
};

/** Deliver one person's saved check-in at the listing door. */
export const deliverAtListingDoor = (
  world: TicketsWorld,
  listing: string,
  who: string,
  places?: number,
): Promise<DoorAnswer> =>
  deliverSavedCheckIn(
    world,
    {
      page: listingPath(world, listing, "scanner"),
      scan: listingPath(world, listing, "scan"),
    },
    listing,
    who,
    places,
  );

/** Deliver one person's saved check-in at the group door. */
export const deliverAtGroupDoor = (
  world: TicketsWorld,
  groupName: string,
  who: string,
  places?: number,
): Promise<DoorAnswer> =>
  deliverSavedCheckIn(
    world,
    groupDoorPaths(world, groupName),
    groupName,
    who,
    places,
  );

/** Deliver the saved check-in one named door stored for one person, at the
 * listing door: the check-in another door's device queued. */
export const deliverSavedFromAnotherDoor = (
  world: TicketsWorld,
  listing: string,
  savedAt: string,
  who: string,
): Promise<DoorAnswer> =>
  deliverSavedCheckIn(
    world,
    {
      page: listingPath(world, listing, "scanner"),
      scan: listingPath(world, listing, "scan"),
    },
    savedAt,
    who,
  );

/** Deliver a saved check-in whose code no door saved: a queued check-in the
 * site cannot match to anybody. */
export const deliverUnknownCode = async (
  world: TicketsWorld,
  listing: string,
): Promise<DoorAnswer> => {
  const delivery: SavedDelivery = {
    code: await sha256Hex("a one-way code no ticket holds"),
    operationId: crypto.randomUUID(),
  };
  world.things.remember("saved_delivery", "last", delivery);
  return postSavedDelivery(
    world,
    {
      page: listingPath(world, listing, "scanner"),
      scan: listingPath(world, listing, "scan"),
    },
    delivery,
  );
};

/** Send the last saved delivery once more: the retry a device makes when its
 * first answer never arrived. */
const redeliverLast = (
  world: TicketsWorld,
  paths: DoorPaths,
): Promise<DoorAnswer> =>
  postSavedDelivery(
    world,
    paths,
    world.things.require("saved_delivery", "last"),
  );

export const redeliverAtListingDoor = (
  world: TicketsWorld,
  listing: string,
): Promise<DoorAnswer> =>
  redeliverLast(world, {
    page: listingPath(world, listing, "scanner"),
    scan: listingPath(world, listing, "scan"),
  });

export const redeliverAtGroupDoor = (
  world: TicketsWorld,
  groupName: string,
): Promise<DoorAnswer> =>
  redeliverLast(world, groupDoorPaths(world, groupName));

/** The places the door's stored rows say were admitted for one person. */
export const placesAdmittedFor = async (
  world: TicketsWorld,
  who: string,
): Promise<number> => {
  const [attendee] = await getAttendeesByTokens([ticketOf(world, who)]);
  if (!attendee) throw new Error(`${who}'s ticket is not on any booking`);
  const rows = await storedCheckinRows(attendee.id);
  return rows.reduce((sum: number, row) => sum + row.checked_in, 0);
};

/** The saved list holds exactly the one-way codes of the tickets the story
 * names — no more, no fewer. */
export const expectSavedCodesFor = async (
  world: TicketsWorld,
  door: string,
  first: string,
  second: string,
): Promise<void> => {
  const codes = await Promise.all(
    [first, second].map((who) => codeFor(world, who)),
  );
  expect(savedCodesAt(world, door).hashes).toEqual(codes.sort());
};

/** No ticket the story holds appears in the saved list in any readable
 * form. */
export const expectNoTicketCodesIn = (
  world: TicketsWorld,
  door: string,
): void => {
  const saved = savedCodesAt(world, door);
  for (const name of world.things.names("ticket")) {
    expect(saved.body).not.toContain(world.things.require("ticket", name));
  }
};

/** The saved list's whole body is the sorted one-way codes and nothing
 * else, so no guest name or address can hide anywhere in it. */
export const expectSavedListNamesNobody = (
  world: TicketsWorld,
  door: string,
): void => {
  expect(savedCodesAt(world, door).body).toMatch(
    /^\{"hashes":\["[0-9a-f]{64}"(?:,"[0-9a-f]{64}")*\]\}$/,
  );
};

/** The door saved a list with no code on it. */
export const expectSavedListEmpty = (
  world: TicketsWorld,
  door: string,
): void => {
  expect(savedCodesAt(world, door).hashes).toEqual([]);
};

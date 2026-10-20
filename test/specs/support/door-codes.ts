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
import { handleRequest } from "#routes";
import { expectAccepted, openAdminPage } from "#test/specs/support/browser.ts";
import {
  attendeeOf,
  cookiesOf,
  type DoorAnswer,
  type DoorPaths,
  doorScanRequest,
  listingDoorPaths,
  listingPath,
  type PathsOfDoor,
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

/** Send one request from the door's own scanner page: the page is opened
 * first, so its cookies — and where the request changes something, its
 * one-use code — are the request's own. */
const fromDoorPage = async (
  world: TicketsWorld,
  paths: DoorPaths,
  request: (browser: TestBrowser) => Request,
): Promise<Response> => {
  const browser = await openAdminPage(world, paths.page);
  return handleRequest(request(browser));
};

/** Save one door's list the way the door's own page saves it on load. The
 * list is kept under the door's name, raw body and all, so the story can
 * check what travelled. */
const saveDoorCodes = async (
  world: TicketsWorld,
  doorName: string,
  paths: DoorPaths,
): Promise<void> => {
  const response = await fromDoorPage(world, paths, (browser) =>
    listRequest(`${paths.scan}-tokens`, browser),
  );
  const body = await expectAccepted(response).text();
  const hashes = v.parse(savedListBody, JSON.parse(body)).hashes;
  world.things.remember("saved_codes", doorName, { body, hashes });
};

/** Save the listing door's list, named the way the story names the listing. */
export const saveListingDoorCodes = (
  world: TicketsWorld,
  listing: string,
): Promise<void> =>
  saveDoorCodes(world, listing, listingDoorPaths(world, listing));

/** Save the group door's list, named the way the story names the group. */
export const saveGroupDoorCodes = (
  world: TicketsWorld,
  groupName: string,
): Promise<void> =>
  saveDoorCodes(world, groupName, groupDoorPaths(world, groupName));

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
  const response = await fromDoorPage(world, paths, (browser) =>
    doorScanRequest(paths.scan, browser, {
      operation_id: delivery.operationId,
      token_hash: delivery.code,
      ...(delivery.places === undefined ? {} : { quantity: delivery.places }),
    }),
  );
  return readDoorAnswer(response);
};

/** Send one queued delivery through the door's own page, and keep it as the
 * delivery a retry sends once more. */
const deliverAndRemember = async (
  world: TicketsWorld,
  paths: DoorPaths,
  code: string,
  places?: number,
): Promise<DoorAnswer> => {
  const delivery: SavedDelivery = {
    code,
    operationId: crypto.randomUUID(),
    ...(places === undefined ? {} : { places }),
  };
  world.things.remember("saved_delivery", "last", delivery);
  return postSavedDelivery(world, paths, delivery);
};

/** The code one door saved for one person, checked against that door's own
 * saved list. A code no door saved fails here rather than testing nothing. */
const savedCodeFor = async (
  world: TicketsWorld,
  listDoorName: string,
  who: string,
): Promise<string> => {
  const code = await codeFor(world, who);
  if (!savedCodesAt(world, listDoorName).hashes.includes(code)) {
    throw new Error(
      `${listDoorName} saved no one-way code for ${who}'s ticket`,
    );
  }
  return code;
};

/** Deliver one person's saved check-in at one door the story names: the
 * delivery must be on that same door's saved list. */
const deliverAt =
  (pathsOf: PathsOfDoor) =>
  async (
    world: TicketsWorld,
    doorName: string,
    who: string,
    places?: number,
  ): Promise<DoorAnswer> =>
    deliverAndRemember(
      world,
      pathsOf(world, doorName),
      await savedCodeFor(world, doorName, who),
      places,
    );

/** Deliver one person's saved check-in at the listing door. */
export const deliverAtListingDoor = deliverAt(listingDoorPaths);

/** Deliver one person's saved check-in at the group door. */
export const deliverAtGroupDoor = deliverAt(groupDoorPaths);

/** Deliver one check-in by its one-way code at the listing door, and keep
 * it as the delivery a retry sends once more. */
const deliverSavedCheckIn = (
  world: TicketsWorld,
  listing: string,
  code: string,
): Promise<DoorAnswer> =>
  deliverAndRemember(world, listingDoorPaths(world, listing), code);

/** Deliver the saved check-in one named door stored for one person, at the
 * listing door: the check-in another door's device queued. */
export const deliverSavedFromAnotherDoor = async (
  world: TicketsWorld,
  listing: string,
  savedAt: string,
  who: string,
): Promise<DoorAnswer> =>
  deliverSavedCheckIn(world, listing, await savedCodeFor(world, savedAt, who));

/** Deliver a saved check-in whose code no door saved: a queued check-in the
 * site cannot match to anybody. */
export const deliverUnknownCode = async (
  world: TicketsWorld,
  listing: string,
): Promise<DoorAnswer> =>
  deliverSavedCheckIn(
    world,
    listing,
    await sha256Hex("a one-way code no ticket holds"),
  );

/** Send the last saved delivery once more, at one door the story names: the
 * retry a device makes when its first answer never arrived. */
const redeliverAt =
  (pathsOf: PathsOfDoor) =>
  (world: TicketsWorld, doorName: string): Promise<DoorAnswer> =>
    postSavedDelivery(
      world,
      pathsOf(world, doorName),
      world.things.require("saved_delivery", "last"),
    );

export const redeliverAtListingDoor = redeliverAt(listingDoorPaths);

export const redeliverAtGroupDoor = redeliverAt(groupDoorPaths);

/** The places the door's stored rows say were admitted for one person. */
export const placesAdmittedFor = async (
  world: TicketsWorld,
  who: string,
): Promise<number> => {
  const rows = await storedCheckinRows((await attendeeOf(world, who)).id);
  return rows.reduce((sum: number, row) => sum + row.checked_in, 0);
};

/** Assert on one door's saved list: the body the door saved, and the codes
 * it holds. The story names the part of it it checks. */
export const expectSavedList = (
  world: TicketsWorld,
  door: string,
  holds: (saved: { body: string; hashes: string[] }) => void,
): void => holds(savedCodesAt(world, door));

/** The saved list holds exactly the one-way codes of the tickets the story
 * names — no more, no fewer. No names at all means the door saved an empty
 * list. */
export const expectSavedCodesFor = async (
  world: TicketsWorld,
  door: string,
  ...who: string[]
): Promise<void> => {
  const codes = await Promise.all(who.map((name) => codeFor(world, name)));
  expectSavedList(world, door, (saved) =>
    expect(saved.hashes).toEqual(codes.sort()),
  );
};

/** The door saved a list with no code on it. */
export const expectSavedListEmpty = (
  world: TicketsWorld,
  door: string,
): Promise<void> => expectSavedCodesFor(world, door);

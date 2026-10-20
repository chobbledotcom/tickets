/**
 * The door's offline support: the saved digest list a door's device holds,
 * and the queued check-ins it replays when the connection is back. Every
 * step goes through the door's own pages and JSON API the way the door's
 * own device would.
 */

import { sha256Hex } from "#crypto/sha256.ts";
// jscpd:ignore-start
import { handleRequest } from "#routes";
import { expectAccepted, openAdminPage } from "#test/specs/support/browser.ts";
import {
  doorRequestHeaders,
  recordPath,
  showTicketAtDoor,
  ticketOf,
} from "#test/specs/support/door.ts";
import { listingIdNamed } from "#test/specs/support/listings.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
// jscpd:ignore-end

/** The saved list one listing's door answers its device, fetched from the
 * door's own page the way the scanner page fetches it. */
export const savedListAtDoor = async (
  world: TicketsWorld,
  listing: string,
): Promise<Record<string, unknown>> => {
  const browser = await openAdminPage(
    world,
    recordPath("listing", listingIdNamed(world, listing), "scanner"),
  );
  const response = await handleRequest(
    new Request(
      `http://localhost/admin/listing/${listingIdNamed(
        world,
        listing,
      )}/scan-tokens`,
      { headers: doorRequestHeaders(browser), method: "GET" },
    ),
  );
  return (await expectAccepted(response).json()) as Record<string, unknown>;
};

/** The organiser replays one queued check-in at one door: the device sends
 * the ticket digest it stored, because it never held the ticket itself. */
export const replayQueuedCheckIn = async (
  world: TicketsWorld,
  listing: string,
  guest: string,
): Promise<void> => {
  world.doorAnswer = await showTicketAtDoor(
    world,
    listing,
    await sha256Hex(ticketOf(world, guest)),
    { replayed: true },
  );
};

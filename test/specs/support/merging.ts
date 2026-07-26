/**
 * The set-up the duplicate-booking stories share: two bookings for the same
 * person on one listing, and the merge the organiser drives from the booking's
 * own Actions page. The page itself supplies the choices — which booking to
 * keep, and what happens to the money — so a page that stops offering one fails
 * the story rather than being worked around.
 */

import { expect } from "@std/expect";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { parseFlashCookie } from "#test-utils/assertions.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  mergePost,
  moneyFieldFor,
  twoPaidDuplicates,
} from "#test-utils/money/drivers.ts";
import { adminGet } from "#test-utils/session.ts";

/** What the merge page offered, and what the organiser was told afterwards. */
export interface MergeOutcome {
  applied: boolean;
  message: string;
}

/** Two bookings for the same person on one listing — paid for twice, or free. */
export const duplicatePair = async (
  world: TicketsWorld,
  name: string,
  options: { paid: boolean },
): Promise<void> => {
  if (options.paid) {
    const pair = await twoPaidDuplicates(name);
    world.listingId = pair.listingId;
    world.attendeeId = pair.targetId;
    world.duplicateId = pair.sourceId;
    world.duplicateToken = pair.sourceToken;
    return;
  }
  const listing = await createTestListing({
    maxAttendees: 10,
    name,
    unitPrice: 0,
  });
  const { attendee: keeper } = await createTestAttendeeDirect(
    listing.id,
    `${name} A`,
    `a-${name}@example.com`.toLowerCase(),
  );
  const { attendee: duplicate, token } = await createTestAttendeeDirect(
    listing.id,
    `${name} B`,
    `b-${name}@example.com`.toLowerCase(),
  );
  world.listingId = listing.id;
  world.attendeeId = keeper.id;
  world.duplicateId = duplicate.id;
  world.duplicateToken = token;
};

/** The booking the organiser keeps. */
export const survivorId = (world: TicketsWorld): number =>
  requiredWorldValue(world.attendeeId, "the booking being kept");

/** The listing the duplicate bookings sit on. */
export const mergedListingId = (world: TicketsWorld): number =>
  requiredWorldValue(world.listingId, "the listing being merged on");

/** Open the merge page and read the choices it offers. */
export const mergeChoices = async (
  world: TicketsWorld,
): Promise<{ bookingField: string; html: string; version: string }> => {
  const token = requiredWorldValue(world.duplicateToken, "the duplicate token");
  const page = await adminGet(
    `/admin/attendees/${survivorId(world)}/actions?token=${encodeURIComponent(token)}`,
  );
  expect(page.status).toBe(200);
  const html = await page.text();
  const version = html.match(/name="merge_version"[^>]*value="([^"]*)"/)?.[1];
  const bookingField = html.match(/name="(booking_[^"]+)"/)?.[1];
  expect(version).toBeDefined();
  expect(bookingField).toBeDefined();
  return { bookingField: bookingField!, html, version: version! };
};

/** Merge the duplicate into the booking being kept, deciding about its money
 * when the organiser has one to make. Returns what they were told. */
export const mergeDuplicates = async (
  world: TicketsWorld,
  money?: "credit" | "writeoff",
): Promise<MergeOutcome> => {
  const { bookingField, version } = await mergeChoices(world);
  const response = await mergePost(survivorId(world), {
    [bookingField]: "keep_target",
    ...(money === undefined ? {} : { [moneyFieldFor(bookingField)]: money }),
    merge_version: version,
    source_token: requiredWorldValue(world.duplicateToken, "duplicate token"),
  });
  // A refused merge sends the organiser back with the reason in the error
  // flash; an applied one reports its success instead.
  const flash = parseFlashCookie(response);
  return {
    applied: !flash.error,
    message: flash.error ?? flash.success ?? "",
  };
};

/**
 * The set-up the duplicate-booking stories share: two bookings for the same
 * person on one listing, and the merge the organiser drives from the booking's
 * own Actions page. The page itself supplies the choices — which booking to
 * keep, and what happens to the money — so a page that stops offering one fails
 * the story rather than being worked around.
 */

import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { parseFlashCookie } from "#test-utils/assertions.ts";
import { extractInputValue } from "#test-utils/csrf.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { adminGet, testCookie, testCsrfToken } from "#test-utils/session.ts";

/** GET the merge preview for `targetId` loaded with `sourceToken`, returning the
 *  `merge_version` the apply POST must echo back AND the name of the conflicting
 *  booking's decision field (`booking_<listingId>:<startAt>`) scraped from the
 *  rendered form, so the test answers the exact conflict the operator is shown
 *  rather than guessing the key. Uses the stable owner cookie — the preview
 *  decrypts the source's PII, needing the session's private key. */
const mergePreview = async (
  targetId: number,
  sourceToken: string,
): Promise<{ bookingField: string; html: string; version: string }> => {
  const page = await adminGet(
    `/admin/attendees/${targetId}/actions?token=${encodeURIComponent(
      sourceToken,
    )}`,
  );
  expect(page.status).toBe(200);
  const html = await page.text();
  const version = extractInputValue(html, "merge_version");
  expect(version).not.toBeNull();
  const bookingField = html.match(/name="(booking_[^"]+)"/)?.[1];
  expect(bookingField).toBeDefined();
  return { bookingField: bookingField!, html, version: version! };
};

/** POST the merge apply form on the SAME stable owner cookie as
 *  {@link mergePreview}, so the apply decrypts the source under the same session
 *  that built the diff (the merge needs the owner's private key). */
const mergePost = async (
  targetId: number,
  fields: Record<string, string>,
): Promise<Response> => {
  const csrf = await testCsrfToken();
  const cookie = await testCookie();
  return handleRequest(
    mockFormRequest(
      `/admin/attendees/${targetId}/merge`,
      { csrf_token: csrf, ...fields },
      cookie,
    ),
  );
};

/** Build a listing with two fully-PAID duplicate bookings (a target and a
 *  token-bearing source) on it — the same-listing conflict decision 17 must
 *  resolve. Income counts BOTH £50 tickets (£100) until the merge un-bills the
 *  discarded one. Returns the ids plus the source's merge token. */
const twoPaidDuplicates = async (
  name: string,
): Promise<{
  listingId: number;
  targetId: number;
  sourceId: number;
  sourceToken: string;
}> => {
  const listing = await createTestListing({
    maxAttendees: 10,
    name,
    unitPrice: 5000,
  });
  const { attendee: target } = await createTestAttendeeDirect(
    listing.id,
    `${name} Target`,
    `target-${name}@example.com`,
  );
  const { attendee: source, token: sourceToken } =
    await createTestAttendeeDirect(
      listing.id,
      `${name} Source`,
      `source-${name}@example.com`,
    );
  await postListingSale({
    attendeeId: target.id,
    gross: 5000,
    listingId: listing.id,
  });
  await postListingSale({
    attendeeId: source.id,
    gross: 5000,
    listingId: listing.id,
  });
  return {
    listingId: listing.id,
    sourceId: source.id,
    sourceToken,
    targetId: target.id,
  };
};

/** The money-decision form field paired with a scraped `booking_<key>` field. */
const moneyFieldFor = (bookingField: string): string =>
  bookingField.replace("booking_", "money_");

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
export const mergeChoices = (
  world: TicketsWorld,
): Promise<{ bookingField: string; html: string; version: string }> =>
  mergePreview(
    survivorId(world),
    requiredWorldValue(world.duplicateToken, "the duplicate token"),
  );

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
  // Either way the organiser is sent to a page and told what happened, so a
  // reply that did neither is a broken merge, not an outcome to report.
  expect(response.status).toBe(302);
  const flash = parseFlashCookie(response);
  const message = flash.error ?? flash.success;
  if (!message) {
    throw new Error("The merge told the organiser nothing at all");
  }
  // A refused merge gives the reason as an error; an applied one reports its
  // success instead.
  return { applied: !flash.error, message };
};

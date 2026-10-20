/**
 * The set-up the duplicate-booking stories share: two bookings for the same
 * person on one listing, and the merge the organiser drives from the booking's
 * own Actions page. The page itself supplies the choices — which booking to
 * keep, and what happens to the money — so a page that stops offering one fails
 * the story rather than being worked around.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { attendeesApi } from "#db/attendees/api.ts";
import { queryAll } from "#db/client.ts";
import { setListingGroups } from "#db/groups.ts";
import { handleRequest } from "#routes";
import { attribute } from "#test/specs/support/form-controls/reading.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { parseFlashCookie } from "#test-utils/assertions.ts";
import { extractInputValue } from "#test-utils/csrf.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { adminGet, testCookie, testCsrfToken } from "#test-utils/session.ts";
import { extractFormEntries } from "#test-utils/test-browser/forms.ts";

// jscpd:ignore-end

/** What the merge page shows before anything is merged: the page itself, the
 *  version it was built from, every booking field it offers a choice about,
 *  and the choices it offers for each of them. */
interface MergePreview {
  bookingChoices: Record<string, string[]>;
  bookingFields: string[];
  html: string;
  version: string;
}

/** GET the merge preview for `targetId` loaded with `sourceToken`. The
 *  duplicate is chosen through the search form the Actions page really
 *  renders: the form is read whole, its action and `token` control are what
 *  a browser would use. The preview returns the `merge_version` the apply
 *  POST must echo back AND the name of the conflicting booking's decision
 *  field (`booking_<listingId>:<startAt>`) scraped from the rendered form, so
 *  the test answers the exact conflict the operator is shown rather than
 *  guessing the key. Uses the stable owner cookie — the preview decrypts the
 *  source's PII, needing the session's private key. */
const mergePreview = async (
  targetId: number,
  sourceToken: string,
): Promise<MergePreview> => {
  const screen = await adminGet(`/admin/attendees/${targetId}/actions`);
  expect(screen.status).toBe(200);
  const searchHtml = await screen.text();
  const search = [
    ...searchHtml.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g),
  ].find(
    ({ 1: attributes, 2: body }) =>
      attributes!.includes('method="get"') &&
      extractFormEntries(body!).some(([name]) => name === "token"),
  );
  if (!search) {
    throw new Error("The merge screen offers no duplicate search form");
  }
  const action = attribute(search[1]!, "action");
  if (!action) {
    throw new Error("The duplicate search form goes nowhere");
  }
  const page = await adminGet(
    `${action}?token=${encodeURIComponent(sourceToken)}`,
  );
  expect(page.status).toBe(200);
  const html = await page.text();
  const version = extractInputValue(html, "merge_version");
  expect(version).not.toBeNull();
  // One booking slot renders as a radio group whose inputs repeat the field
  // name once per choice: keep one name per slot in the order the page offers
  // them, and beside it the choice values the page offers for that slot.
  const bookingFields: string[] = [];
  const bookingChoices: Record<string, string[]> = {};
  for (const input of html.matchAll(/<input\b[^>]*>/g)) {
    const field = /name="(booking_[^"]+)"/.exec(input[0]!)?.[1];
    const choice = /value="([^"]+)"/.exec(input[0]!)?.[1];
    if (field === undefined || choice === undefined) continue;
    const offered = bookingChoices[field] ?? [];
    if (offered.length === 0) bookingFields.push(field);
    if (!offered.includes(choice)) offered.push(choice);
    bookingChoices[field] = offered;
  }
  expect(bookingFields.length).toBeGreaterThan(0);
  return { bookingChoices, bookingFields, html, version: version! };
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
  for (const attendeeId of [target.id, source.id]) {
    await postListingSale({ attendeeId, gross: 5000, listingId: listing.id });
  }
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
export const mergeChoices = (world: TicketsWorld): Promise<MergePreview> =>
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
  const [bookingField] = (await mergeChoices(world)).bookingFields;
  return mergeDeciding(world, [
    {
      choice: "keep_target",
      field: bookingField!,
      ...(money === undefined ? {} : { money }),
    },
  ]);
};

/** One booking decision: which slot, which side wins, and what happens to the
 * discarded money when that booking was paid for. */
export type MergeBookingDecision = {
  choice: "keep_target" | "take_source" | "skip_source";
  field: string;
  money?: "credit" | "writeoff";
};

/** Merge the duplicate into the booking being kept, deciding every conflicting
 * booking through the real merge form. Each choice must be one the page
 * offered: the organiser can pick only there, so a page that drops the choice
 * fails the story before anything is posted. */
export const mergeDeciding = async (
  world: TicketsWorld,
  decisions: MergeBookingDecision[],
): Promise<MergeOutcome> => {
  const { bookingChoices, version } = await mergeChoices(world);
  const fields: Record<string, string> = {
    merge_version: version,
    source_token: requiredWorldValue(world.duplicateToken, "duplicate token"),
  };
  for (const decision of decisions) {
    const offered = bookingChoices[decision.field] ?? [];
    if (!offered.includes(decision.choice)) {
      throw new Error(
        `The merge page offered ${JSON.stringify(offered)} for ${decision.field}, not the ${decision.choice} the story chose`,
      );
    }
    fields[decision.field] = decision.choice;
    if (decision.money !== undefined) {
      fields[moneyFieldFor(decision.field)] = decision.money;
    }
  }
  return mergeOutcomeOf(await mergePost(survivorId(world), fields));
};

/** What the site told the organiser the merge did. */
const mergeOutcomeOf = async (response: Response): Promise<MergeOutcome> => {
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

/** The booking field booked through a bundle: the one offered slot that is
 * not the plain on-its-own booking. A slot key ends `parent:package`, so a
 * plain booking ends `:0:0`; the key's middle carries the booking's
 * timestamp, which can hold colons of its own, so the shape is read from the
 * end. */
export const bundleBookingField = (fields: readonly string[]): string => {
  const bundled = fields.filter((field) => !field.endsWith(":0:0"));
  if (bundled.length !== 1) {
    throw new Error(
      `Expected one bundle part among ${fields.length} offered bookings, found ${bundled.length}`,
    );
  }
  return bundled[0]!;
};

/** The booking field booked on its own: the one offered slot whose key ends
 * `:0:0` — no parent, no bundle. */
export const plainBookingField = (fields: readonly string[]): string => {
  const plain = fields.filter((field) => field.endsWith(":0:0"));
  if (plain.length !== 1) {
    throw new Error(
      `Expected one on-its-own booking among ${fields.length} offered bookings, found ${plain.length}`,
    );
  }
  return plain[0]!;
};

/** One booking slot a duplicate pair holds: how many places, whether the slot
 * rides a bundle, and over which days. */
export type PairSlot = {
  bundle?: boolean;
  date?: string;
  durationDays?: number;
  quantity: number;
};

/** Two bookings for the same person on one listing, each holding the slots
 * their side names. A bundle slot rides a real package group, so its rows
 * match what a true bundle checkout stores, and each side is paid for what it
 * holds when the pair is paid. */
export const duplicatePairOnSlots = async (
  world: TicketsWorld,
  name: string,
  slots: { source: PairSlot[]; target: PairSlot[] },
  options: { daily?: boolean; paid?: boolean } = {},
): Promise<void> => {
  const paid = options.paid ?? false;
  const unitPrice = paid ? 5000 : 0;
  const listing =
    options.daily === true
      ? await createDailyTestListing({
          durationDays: 2,
          maxAttendees: 10,
          name,
          thankYouUrl: "",
          unitPrice,
        })
      : await createTestListing({ maxAttendees: 10, name, unitPrice });
  const bundlesSlots = [...slots.source, ...slots.target];
  let packageGroupId = 0;
  if (bundlesSlots.some((slot) => slot.bundle === true)) {
    const group = await createTestGroup({
      isPackage: true,
      name: `${name} Bundle`,
    });
    await setListingGroups(listing.id, [group.id]);
    packageGroupId = group.id;
  }
  const bookingsFor = async (
    who: string,
    email: string,
    pairSlots: PairSlot[],
  ) => {
    const result = await attendeesApi.createAttendeeAtomic({
      address: "",
      bookings: pairSlots.map((slot) => ({
        listingId: listing.id,
        packageGroupId: slot.bundle === true ? packageGroupId : undefined,
        quantity: slot.quantity,
        ...(slot.date === undefined
          ? {}
          : { date: slot.date, durationDays: slot.durationDays ?? 1 }),
      })),
      email,
      name: `${name} ${who}`,
      phone: "",
      special_instructions: "",
    });
    if (!result.success) {
      throw new Error(
        `Failed to book the ${who.toLowerCase()} duplicate on the ${name}: ${result.reason}`,
      );
    }
    return result.attendees[0]!;
  };
  const target = await bookingsFor(
    "Target",
    `target-${name}@example.com`,
    slots.target,
  );
  const source = await bookingsFor(
    "Source",
    `source-${name}@example.com`,
    slots.source,
  );
  if (paid) {
    for (const [attendee, pairSlots] of [
      [target, slots.target],
      [source, slots.source],
    ] as const) {
      const places = pairSlots.reduce((sum, slot) => sum + slot.quantity, 0);
      await postListingSale({
        attendeeId: attendee.id,
        gross: unitPrice * places,
        listingId: listing.id,
      });
    }
  }
  world.listingId = listing.id;
  world.attendeeId = target.id;
  world.duplicateId = source.id;
  world.duplicateToken = source.ticket_token;
};

/** The booking rows the kept booking holds on the merged listing: what it
 * counts, which path each row rode, and the days it covers. */
export const keptBookingRows = async (
  world: TicketsWorld,
): Promise<
  {
    end_at: string | null;
    package_group_id: number;
    quantity: number;
    start_at: string | null;
  }[]
> =>
  queryAll(
    `SELECT package_group_id, quantity, start_at, end_at FROM listing_attendees
      WHERE attendee_id = ? AND listing_id = ?`,
    [survivorId(world), mergedListingId(world)],
  );

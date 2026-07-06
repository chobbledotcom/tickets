/**
 * Shared arrange/act/assert helpers for the parent/child booking suites.
 *
 * Three chores were copy-pasted across `server-parents-*`, `server-booking-*`,
 * `server-bookable-alone`, and `server-listing-qr-admin`:
 *   1. "What is the first day this listing can be booked?" — the three-import
 *      dance (dates + holidays + listing row) that every daily-listing test
 *      repeats to reach one date string.
 *   2. "Book this parent as Ada" — the standard contact + parent-quantity form
 *      POST.
 *   3. "That booking should have bounced" — the 302 + failure flash + no
 *      attendee-row-left-behind tail.
 * Each lives here once so a test states what it is checking, not the plumbing.
 */

import { expect } from "@std/expect";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import { setChildIds } from "#shared/db/listing-parents.ts";
import type { Group, Listing } from "#shared/types.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers.ts";
import { apiGet, makeParent, postBooking } from "#test-utils/parents.ts";

// ---------------------------------------------------------------------------
// Bookable-date lookups (holiday-aware)
// ---------------------------------------------------------------------------

/** Every day a listing can be booked to start on, with the active holidays
 * already taken out — the shared answer behind {@link firstBookableDate}. */
export const bookableDatesFor = async (
  listingId: number,
): Promise<string[]> => {
  const { getBookableStartDates } = await import("#shared/dates.ts");
  const { getActiveHolidays } = await import("#shared/db/holidays.ts");
  const { getListingWithCount } = await import("#shared/db/listings.ts");
  const row = (await getListingWithCount(listingId))!;
  return getBookableStartDates(row, await getActiveHolidays());
};

/** The first day a listing can be booked to start on. */
export const firstBookableDate = async (listingId: number): Promise<string> =>
  (await bookableDatesFor(listingId))[0]!;

/** The weekday name (Sunday…Saturday, matching `DAY_NAMES`) of an ISO date. */
export const weekdayOf = async (date: string): Promise<string> => {
  const { DAY_NAMES } = await import("#shared/dates.ts");
  return DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
};

/** Turn the public JSON API on (so `/api/listings*` endpoints answer). */
export const enablePublicApi = async (): Promise<void> => {
  const { settings } = await import("#shared/db/settings.ts");
  await settings.update.showPublicApi(true);
};

/** GET a public-API listing endpoint (`/api/listings/<slug><suffix>`) and return
 * its parsed JSON body — the shared read behind the detail/availability tests. */
export const apiListingBody = async <T>(
  slug: string,
  suffix = "",
): Promise<T> =>
  (await (await apiGet(`/api/listings/${slug}${suffix}`)).json()) as T;

/** Assert the JSON API detail for `slug` describes a bookable listing: it echoes
 * the slug and offers at least one purchasable spot. */
export const expectListingDetailBookable = async (
  slug: string,
): Promise<void> => {
  const body = await apiListingBody<{
    listing: { slug: string; maxPurchasable: number };
  }>(slug);
  expect(body.listing.slug).toBe(slug);
  expect(body.listing.maxPurchasable).toBeGreaterThan(0);
};

/** The `<option>` markup inside the first `<select name="{name}">` of `html` —
 * the shared "read what a dropdown offers" snip the render tests all do by
 * hand. */
export const selectOptions = (html: string, name: string): string => {
  const select = html.slice(html.indexOf(`name="${name}"`));
  return select.slice(0, select.indexOf("</select>"));
};

// ---------------------------------------------------------------------------
// Booking a parent as the standard test buyer
// ---------------------------------------------------------------------------

/** POST a booking for a single parent as Ada (a@b.com), choosing `quantity` of
 * the parent. Extra form fields (a chosen date, child quantities, a different
 * buyer, …) are merged in and win over the defaults. */
export const bookOne = (
  parent: Listing,
  quantity: number,
  extra: Record<string, string> = {},
): Promise<Response> =>
  postBooking(parent.slug, {
    email: "a@b.com",
    name: "Ada",
    [`quantity_${parent.id}`]: String(quantity),
    ...extra,
  });

/** Assert a booking bounced: a 302 back to the page, the given failure flash
 * (`undefined` only requires *some* failure flash), and no attendee row left
 * behind for `emptyListingId`. */
export const expectBookingRejected = async (
  res: Response,
  // deno-lint-ignore no-explicit-any
  flash: string | any,
  emptyListingId: number,
): Promise<void> => {
  expect(res.status).toBe(302);
  expectFlash(res, flash, false);
  expect((await getAttendeesRaw(emptyListingId)).length).toBe(0);
};

/** Assert exactly one attendee line of `quantity` was written for `booked`, and
 * none at all for `notBooked` — the shared "only the chosen child folded" check. */
export const expectOnlyChildBooked = async (
  booked: Listing,
  notBooked: Listing,
  quantity = 1,
): Promise<void> => {
  const rows = await getAttendeesRaw(booked.id);
  expect(rows.length).toBe(1);
  expect(rows[0]?.quantity).toBe(quantity);
  expect((await getAttendeesRaw(notBooked.id)).length).toBe(0);
};

/** Assert both children each got exactly one attendee line of quantity 1 — the
 * "one of each child folded" persistence check. */
export const expectEachChildQtyOne = async (
  childA: Listing,
  childB: Listing,
): Promise<{
  rowsA: Awaited<ReturnType<typeof getAttendeesRaw>>;
  rowsB: Awaited<ReturnType<typeof getAttendeesRaw>>;
}> => {
  const rowsA = await getAttendeesRaw(childA.id);
  const rowsB = await getAttendeesRaw(childB.id);
  expect(rowsA.length).toBe(1);
  expect(rowsA[0]?.quantity).toBe(1);
  expect(rowsB.length).toBe(1);
  expect(rowsB[0]?.quantity).toBe(1);
  return { rowsA, rowsB };
};

// ---------------------------------------------------------------------------
// Repeated arrange blocks
// ---------------------------------------------------------------------------

/** A daily "Daily base" parent whose only child is a daily "Daily add-on"
 * bookable on every weekday EXCEPT the parent's first bookable date's weekday —
 * so the parent's own date is one its child can never serve. Returns the pair
 * plus that parent date. */
export const dailyParentWithChildOffParentDay = async (): Promise<{
  parent: Listing;
  child: Listing;
  parentDate: string;
}> => {
  const { DAY_NAMES } = await import("#shared/dates.ts");
  const parent = await createDailyTestListing({ name: "Daily base" });
  const parentDate = await firstBookableDate(parent.id);
  const parentDay = await weekdayOf(parentDate);
  const child = await createDailyTestListing({
    bookableDays: DAY_NAMES.filter((d) => d !== parentDay),
    name: "Daily add-on",
  });
  await setChildIds(parent.id, [child.id]);
  return { child, parent, parentDate };
};

/** Two "Base A"/"Base B" parents sharing one child, each parent capped at
 * `parentMaxQuantity`. The child's own overrides (capacity, price, name) are
 * caller-supplied. The common "one add-on required by two bases" arrange. */
export const twoParentsSharingChild = async (
  childOverrides: Parameters<typeof createTestListing>[0],
  parentMaxQuantity = 5,
): Promise<{ parentA: Listing; parentB: Listing; child: Listing }> => {
  const parentA = await createTestListing({
    maxQuantity: parentMaxQuantity,
    name: "Base A",
  });
  const parentB = await createTestListing({
    maxQuantity: parentMaxQuantity,
    name: "Base B",
  });
  const child = await createTestListing(childOverrides);
  await setChildIds(parentA.id, [child.id]);
  await setChildIds(parentB.id, [child.id]);
  return { child, parentA, parentB };
};

/** Attach a single radio question (default "Size?" with one answer "Large") to a
 * listing and return the created question + answer rows. The shared "give this
 * listing a multiple-choice question" arrange. */
export const addRadioQuestion = async (
  listingId: number,
  text = "Size?",
  answerText = "Large",
) => {
  const { answersTable, questionsTable, setListingQuestions } = await import(
    "#shared/db/questions.ts"
  );
  const question = await questionsTable.insert({ displayType: "radio", text });
  const answer = await answersTable.insert({
    questionId: question.id,
    sortOrder: 0,
    text: answerText,
  });
  await setListingQuestions(listingId, [question.id]);
  return { answer, question };
};

/** A parent with two children where the second is blocked from booking — either
 * deactivated (`"inactive"`) or with registration closed in the past
 * (`"closed"`). Returns the parent, the still-bookable first child, and the
 * blocked one. */
export const parentWithBlockedSecondChild = async (
  how: "inactive" | "closed",
): Promise<{ parent: Listing; okChild: Listing; blockedChild: Listing }> => {
  const { parent, children } = await makeParent({ children: [{}, {}] });
  const okChild = children[0]!;
  const blockedChild = children[1]!;
  const { execute } = await import("#shared/db/client.ts");
  if (how === "inactive") {
    await execute("UPDATE listings SET active = 0 WHERE id = ?", [
      blockedChild.id,
    ]);
  } else {
    const { writeClosesAt } = await import("#shared/db/listings.ts");
    await execute("UPDATE listings SET closes_at = ? WHERE id = ?", [
      await writeClosesAt("2000-01-01T00:00:00.000Z"),
      blockedChild.id,
    ]);
  }
  return { blockedChild, okChild, parent };
};

/** A daily parent + daily child sharing one 2-spot capped "Pool", plus a daily
 * "Daily filler" in the same pool used to burn spots on a chosen date, plus the
 * parent's bookable dates. The shared arrange for the daily-group date tests. */
export const dailyPairSharingPoolWithFiller = async (): Promise<{
  group: Group;
  parent: Listing;
  child: Listing;
  filler: Listing;
  dates: string[];
}> => {
  const { group, parent, child } = await makeParent({
    children: [{ daily: true }],
    group: { maxAttendees: 2, name: "Pool" },
    parent: { daily: true },
  });
  const filler = await createDailyTestListing({
    groupId: group!.id,
    name: "Daily filler",
    thankYouUrl: "",
  });
  const dates = await bookableDatesFor(parent.id);
  return { child, dates, filler, group: group!, parent };
};

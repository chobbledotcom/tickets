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
import type { CheckoutIntent } from "#shared/payments.ts";
import type { Group, Listing } from "#shared/types.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers.ts";
import {
  apiBook,
  apiGet,
  bookingPageHtml,
  makeParent,
  postBooking,
} from "#test-utils/parents.ts";

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

/** POST a JSON-API booking of one unit of `child` under `parent`. Extra body
 * fields (a date, a quantity, …) merge in. */
export const apiBookOneChild = (
  parent: Listing,
  child: Listing,
  extra: Record<string, unknown> = {},
): Promise<Response> =>
  apiBook(parent.slug, {
    children: [{ quantity: 1, slug: child.slug }],
    ...extra,
  });

/** The `GET /api/listings` collection row whose slug matches `slug`. */
export const apiListingRow = async <T extends { slug: string }>(
  slug: string,
): Promise<T> => {
  const body = (await (await apiGet("/api/listings")).json()) as {
    listings: T[];
  };
  return body.listings.find((l) => l.slug === slug)!;
};

/** Render the parent's booking page and assert its quantity selector offers the
 * `allowed` option but not the `forbidden` one (values compared as `>N</option>`
 * so a substring can't false-match). The shared group-cap render check. */
export const expectQuantityCap = async (
  parent: Listing,
  allowed: string,
  forbidden: string,
): Promise<void> => {
  const html = await bookingPageHtml(parent.slug);
  const options = selectOptions(html, `quantity_${parent.id}`);
  expect(options).toContain(`>${allowed}</option>`);
  expect(options).not.toContain(`>${forbidden}</option>`);
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

/** Book a parent at quantity 2 as Ada, choosing one unit of each of two
 * children — the shared "one of each child folds two lines" act. */
export const bookOneOfEachChild = (
  parent: Listing,
  childA: Listing,
  childB: Listing,
): Promise<Response> =>
  bookOne(parent, 2, {
    [`child_qty_${parent.id}_${childA.id}`]: "1",
    [`child_qty_${parent.id}_${childB.id}`]: "1",
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

/** Assert the parent's availability endpoint reports the given per-child
 * availabilities (order-independent). Each pair is `[child, isAvailable]`. */
export const expectChildAvailability = async (
  parentSlug: string,
  expected: [Listing, boolean][],
  suffix = "/availability",
): Promise<void> => {
  const body = await apiListingBody<{
    children?: { slug: string; available: boolean }[];
  }>(parentSlug, suffix);
  expect(body.children).toEqual(
    expect.arrayContaining(
      expected.map(([child, available]) => ({ available, slug: child.slug })),
    ),
  );
};

/** Assert a captured checkout intent carries a 3-day span and prices the folded
 * `child` for that span (£30) — the "child inherited the fixed 3-day parent
 * duration" check shared by the web and API paid-booking tests. */
export const expectFoldedChild3DaySpan = (
  intent: CheckoutIntent | undefined,
  child: Listing,
): void => {
  expect(intent?.dayCount).toBe(3);
  const childItem = intent?.items.find((i) => i.listingId === child.id);
  expect(childItem?.unitPrice).toBe(3000);
};

/** Assert the newest attendee line for `child` has the given quantity. */
export const expectChildQuantity = async (
  child: Listing,
  quantity: number,
): Promise<void> => {
  const rows = await getAttendeesRaw(child.id);
  expect(rows[0]?.quantity).toBe(quantity);
};

/** An ungrouped parent (max 50 capacity) whose two children share one capped
 * "Add-on pool" of `poolMax` spots; the parent's quantity ceiling is
 * `parentMaxQuantity`. Each child is capped at 5 with 50 capacity. */
export const twoChildrenInCappedPool = async (
  poolMax: number,
  parentMaxQuantity: number,
): Promise<Awaited<ReturnType<typeof makeParent>>> => {
  const { createTestGroup } = await import("#test-utils/db-helpers.ts");
  const childGroup = await createTestGroup({
    maxAttendees: poolMax,
    name: "Add-on pool",
  });
  return makeParent({
    children: [
      { groupId: childGroup.id, maxAttendees: 50, maxQuantity: 5 },
      { groupId: childGroup.id, maxAttendees: 50, maxQuantity: 5 },
    ],
    parent: { maxAttendees: 50, maxQuantity: parentMaxQuantity },
  });
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

/** A daily parent (default name "Daily base") plus its bookable start dates —
 * the standard starting point for the daily date-selector render tests. */
export const dailyBaseWithDates = async (
  overrides: Parameters<typeof createDailyTestListing>[0] = {
    name: "Daily base",
  },
): Promise<{ parent: Listing; parentDates: string[] }> => {
  const parent = await createDailyTestListing(overrides);
  return { parent, parentDates: await bookableDatesFor(parent.id) };
};

/** A parent with two plain children, returned as `childA`/`childB`. Extra parent
 * overrides (e.g. `{ maxQuantity: 5 }`) merge onto the default. */
export const twoChildParent = async (
  parentOverrides: Parameters<typeof createTestListing>[0] = {},
): Promise<{ parent: Listing; childA: Listing; childB: Listing }> => {
  const { parent, children } = await makeParent({
    children: [{}, {}],
    parent: parentOverrides,
  });
  return { childA: children[0]!, childB: children[1]!, parent };
};

/** A parent (max 100 capacity, quantity 5) whose two children each have a single
 * spot in their own separate pools — so the children's caps combine (1 + 1). */
export const twoSeparatePoolChildrenParent = (): ReturnType<
  typeof makeParent
> =>
  makeParent({
    children: [{ maxAttendees: 1 }, { maxAttendees: 1 }],
    parent: { maxAttendees: 100, maxQuantity: 5 },
  });

/** A daily parent whose only child is a daily add-on bookable on Mondays only —
 * so the parent offers dates its child cannot serve. */
export const dailyParentMondayOnlyChild = (): ReturnType<typeof makeParent> =>
  makeParent({
    children: [{ bookableDays: ["Monday"], daily: true }],
    parent: { daily: true },
  });

/** A daily parent whose only child is a daily add-on with a single spot
 * (`maxAttendees: 1`). Extra parent overrides merge onto `{ daily: true }`. */
export const dailyParentWithOneCapChild = (
  parentOverrides: Parameters<typeof createTestListing>[0] = {},
): ReturnType<typeof makeParent> =>
  makeParent({
    children: [{ daily: true, maxAttendees: 1 }],
    parent: { daily: true, ...parentOverrides },
  });

/** A pay-what-you-want parent (unit £10, up to £50) whose only child is free —
 * so a submitted custom price lands wholly on the parent line. */
export const payMoreParentWithFreeChild = (): ReturnType<typeof makeParent> =>
  makeParent({
    children: [{ maxAttendees: 50, unitPrice: 0 }],
    parent: {
      canPayMore: true,
      maxAttendees: 50,
      maxPrice: 5000,
      unitPrice: 1000,
    },
  });

/** A FIXED 3-day daily parent whose only child is customisable (priced £10 for
 * 1 day, £30 for 3) — so the child inherits and must be priced for the parent's
 * 3-day span. The shared "fixed parent, customisable add-on" arrange. */
export const fixedThreeDayParentWithCustomChild = (): ReturnType<
  typeof makeParent
> =>
  makeParent({
    children: [
      {
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 3000 },
        durationDays: 3,
        maxPrice: 0,
        unitPrice: 0,
      },
    ],
    parent: { daily: true, durationDays: 3 },
  });

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

/** A "Base unit" parent in a roomy shared group A (10 spots) and its "Add-on"
 * child in BOTH group A and its own tighter private group B (1 spot) — so the
 * shared-pool check must read group A, not the child's tightest group. */
export const parentChildRoomySharedTightPrivate = async (): Promise<{
  parent: Listing;
  child: Listing;
}> => {
  const { createTestGroup, createTestListing } = await import(
    "#test-utils/db-helpers.ts"
  );
  const groupA = await createTestGroup({ maxAttendees: 10, name: "Shared" });
  const groupB = await createTestGroup({ maxAttendees: 1, name: "Tighter" });
  const parent = await createTestListing({
    groupIds: [groupA.id],
    maxAttendees: 100,
    name: "Base unit",
  });
  const child = await createTestListing({
    groupIds: [groupA.id, groupB.id],
    maxAttendees: 100,
    name: "Add-on",
  });
  await setChildIds(parent.id, [child.id]);
  return { child, parent };
};

/** A regular group whose sole member is a child of a parent OUTSIDE the group,
 * so the group folds empty. Returns the group. */
export const groupWithChildOnlyMember = async (
  name: string,
): Promise<Group> => {
  const { createTestGroup } = await import("#test-utils/db-helpers.ts");
  const group = await createTestGroup({ name });
  await makeParent({ children: [{ groupId: group.id }] });
  return group;
};

/** A regular group whose sole member is a parent (in the group) whose one
 * required child is sold out — so the group projects sold out. Returns the
 * group. */
export const groupWithSoldOutParentMember = async (
  name: string,
): Promise<Group> => {
  const { createTestAttendee, createTestGroup, createTestListing } =
    await import("#test-utils/db-helpers.ts");
  const group = await createTestGroup({ name });
  const parent = await createTestListing({
    groupId: group.id,
    name: "Base in group",
  });
  const child = await createTestListing({
    maxAttendees: 1,
    name: "Sold-out add-on",
  });
  await createTestAttendee(child.id, child.slug, "Buyer", "b@x.com");
  await setChildIds(parent.id, [child.id]);
  return group;
};

/** GET a group's public QR image (`/ticket/<slug>/qr`) and return its status,
 * draining the body. */
export const groupQrStatus = async (slug: string): Promise<number> => {
  const { handleRequest } = await import("#routes");
  const res = await handleRequest(
    new Request(`http://localhost/ticket/${slug}/qr`, {
      headers: { host: "localhost" },
    }),
  );
  res.body?.cancel();
  return res.status;
};

/** With the public site on, assert the /listings page shows no Book link to a
 * group's `/ticket/<slug>` page — the shared dead-CTA suppression check. */
export const expectGroupCtaSuppressed = async (
  groupSlug: string,
): Promise<void> => {
  const { settings } = await import("#shared/db/settings.ts");
  await settings.update.showPublicSite(true);
  const { handleRequest } = await import("#routes");
  const { mockRequest } = await import("#test-utils/mocks.ts");
  const body = await (await handleRequest(mockRequest("/listings"))).text();
  expect(body).not.toContain(`href="/ticket/${groupSlug}"`);
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

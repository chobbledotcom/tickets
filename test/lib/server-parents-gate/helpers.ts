/**
 * Shared helpers for the split `server-parents-gate/` suite.
 *
 * The single 2,700-line monolith repeatedly inlined the same Stripe
 * checkout-stub capture, table-driven contains/notContains loop runner, and
 * select-option slicer. The split would have surfaced each as a jscpd clone,
 * so each lives here once. The booking-body, reject/fold assertion, and
 * `bookableStartDates`/`makeCustomisableDailyParent` patterns are shared across
 * the broader parents suite, so they live in `#test-utils` (parents.ts /
 * db-helpers/listings.ts) instead.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { DAY_NAMES } from "#shared/day-names.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import type { Listing } from "#shared/types.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  bookableStartDates,
  createDailyTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { bookingPageHtml, makeParent } from "#test-utils/parents.ts";
import { weekdayOf } from "../booking-model-fixtures.ts";

/** The first date a listing can be booked for — the common single-date need.
 *  Delegates to the shared {@link bookableStartDates} (from `#test-utils`) and
 *  picks the first. */
export const firstBookableDate = async (listingId: number): Promise<string> =>
  (await bookableStartDates(listingId))[0]!;

/** A daily parent + a 1-capacity daily child, with the child's single spot on
 *  day A already filled — the shared "date-less sold-out aggregate reads true,
 *  but the child still folds/renders on day B" setup behind one daily-fold test
 *  and one render-dates test. Returns `dayA` so the caller can book or assert
 *  against the full date. */
export const makeDailyChildFilledOnDayA = async (): Promise<{
  child: Listing;
  dayA: string;
  parent: Listing;
}> => {
  const { parent, child } = await makeParent({
    children: [{ daily: true, maxAttendees: 1 }],
    parent: { daily: true },
  });
  const dayA = await firstBookableDate(child.id);
  const booked = await bookAttendee(child, { date: dayA });
  expect(booked.success).toBe(true);
  return { child, dayA, parent };
};

/** A daily child bookable on every weekday EXCEPT the parent's first bookable
 *  date's weekday, wired as the parent's only child. Returns the parent date so
 *  the caller can post it. Shared by the two "excluded date" rejection tests. */
export const childExcludingParentDay = async (
  parent: Listing,
): Promise<{ child: Listing; parentDate: string }> => {
  const parentDate = await firstBookableDate(parent.id);
  const parentDay = weekdayOf(parentDate);
  const child = await createDailyTestListing({
    bookableDays: DAY_NAMES.filter((d) => d !== parentDay),
    name: "Daily add-on",
  });
  await listingChildren.setIds(parent.id, [child.id]);
  return { child, parentDate };
};

/** A daily parent + daily child sharing a 2-spot "Pool" group, plus a daily
 *  filler that fills BOTH of the group's spots on day A — the shared setup
 *  behind the two "group full on one date" tests (one books the free day B,
 *  the other the full day A). */
export const makeDailyGroupWithFiller = async (): Promise<{
  child: Listing;
  dayA: string;
  dayB: string;
  parent: Listing;
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
  const dates = await bookableStartDates(parent.id);
  const [dayA, dayB] = [dates[0]!, dates[1]!];
  const booked = await bookAttendee(filler, { date: dayA, quantity: 2 });
  expect(booked.success).toBe(true);
  return { child, dayA, dayB, parent };
};

/**
 * Stub the Stripe checkout provider and capture the intent handed to it,
 *  after first configuring Stripe for the test isolate — the shared
 *  "inspect what checkout would have charged" fixture for the parents-gate
 *  suite. Returns the same shape as the shared {@link stubCheckout}
 *  (`{ checkout, getCaptured, calls }`) so the one mechanism keeps one
 *  vocabulary; callers use `getCaptured()` / `calls()` /
 *  `checkout.restore()` directly. The `setupStripe()` call is the only thing
 *  this wrapper adds on top.
 */
export const stubCheckoutIntent = async (sessionId: string) => {
  const { setupStripe } = await import("#test-utils/settings.ts");
  const { stubCheckout } = await import("#test-utils/checkout.ts");
  await setupStripe();
  return stubCheckout(sessionId);
};

/** A table-driven booking-page render case: build the parent from `spec`,
 *  fetch the page, and assert each `contains` / `notContains` substring. The
 *  shape shared by the price-label and day-count-union case tables, so the two
 *  loops don't each re-declare an identical runner. */
export type ContainsCase = {
  name: string;
  spec: Parameters<typeof makeParent>[0];
  contains: string[];
  notContains: string[];
};

/** Run a list of {@link ContainsCase}s as one `test` each. */
export const runContainsCases = (cases: readonly ContainsCase[]): void => {
  for (const c of cases) {
    test(c.name, async () => {
      const { parent } = await makeParent(c.spec);
      const html = await bookingPageHtml(parent.slug);
      for (const needle of c.contains) expect(html).toContain(needle);
      for (const needle of c.notContains) {
        expect(html).not.toContain(needle);
      }
    });
  }
};

/** The inner `<option>` HTML of the `<select name="…">` in `html`, sliced out
 *  so a test can assert which options are/aren't offered. Replaces the per-test
 *  `html.slice(html.indexOf(\`name="…"\`))` + `.slice(0, indexOf("</select>"))`
 *  pair that recurred across the capacity/selector/render tests. Use
 *  {@link selectOptionsHtml} when you need to fetch the page first; use this
 *  directly when you already have the HTML (e.g. from a redirect-follow).
 *
 *  Matches a `<select>` opening tag that carries the requested `name` (not
 *  just any element with that name attribute), so an `<input name="…">` or
 *  other tag reusing the name can't mask a missing select. Throws a named
 *  error when no such `<select>` exists, so callers get an immediate, readable
 *  signal instead of a misleading near-full-page slice. */
export const selectOptionsFromHtml = (
  html: string,
  selectName: string,
): string => {
  const needle = `<select name="${selectName}"`;
  const start = html.indexOf(needle);
  if (start === -1) {
    throw new Error(`No <select name="${selectName}"> found in HTML`);
  }
  const select = html.slice(start);
  return select.slice(0, select.indexOf("</select>"));
};

/** The inner `<option>` HTML of the `<select name="…">` rendered on `slug`'s
 *  booking page — fetches the page then delegates to
 *  {@link selectOptionsFromHtml}. */
export const selectOptionsHtml = async (
  slug: string,
  selectName: string,
): Promise<string> =>
  selectOptionsFromHtml(await bookingPageHtml(slug), selectName);

/** Assert the options of a rendered `<select>` include `available` and omit
 *  `notAvailable` — the shared "the selector offers N but not N+1" check behind
 *  every group-cap and separate-pool render test. */
export const expectSelectOffers = async (
  slug: string,
  selectName: string,
  available: string,
  notAvailable: string,
): Promise<void> => {
  const options = await selectOptionsHtml(slug, selectName);
  expect(options).toContain(available);
  expect(options).not.toContain(notAvailable);
};

/** Assert a parent's booking page renders its sold-out message and emits no
 *  quantity selector. Returns the page HTML so a caller can add further
 *  "no child selector" assertions. The shared check behind every sold-out
 *  projection render test. */
export const expectRendersSoldOut = async (
  slug: string,
  parentId: number,
): Promise<string> => {
  const html = await bookingPageHtml(slug);
  expect(html).toContain("Sorry, this listing is full.");
  expect(html).not.toContain(`name="quantity_${parentId}"`);
  return html;
};

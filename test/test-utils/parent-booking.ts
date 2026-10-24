/**
 * HTTP request and assertion helpers for the parent/child listings feature's
 * booking side: the ticket-page booking and quote posts, the JSON API reads,
 * and the persistence checks the parent suites share. The declarative
 * scenario builders live in `parents.ts`.
 */

import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import type { Listing } from "#types";
import { expectAttendeeCounts, expectFlash } from "./assertions.ts";
import { enablePublicSite } from "./settings.ts";

/** GET `/ticket/<slugs>` and return the raw Response. */
export const ticketGet = async (slugs: string): Promise<Response> =>
  awaitTestRequest(`/ticket/${slugs}`);

/** GET the booking-page HTML for `slugs`. */
export const bookingPageHtml = async (slugs: string): Promise<string> =>
  (await ticketGet(slugs)).text();

/** A CSRF token for posting to `/ticket/<slugs>`. Prefers the token embedded in
 * the rendered form; when the page renders no form (e.g. a parent projected to
 * sold-out because it has no bookable child), falls back to a freshly-minted
 * token so the submit-side gate can still be exercised. */
export const bookingPageToken = async (slugs: string): Promise<string> => {
  const { extractCsrfToken } = await import("#test-utils/csrf.ts");
  const { signCsrfToken } = await import("#shared/csrf.ts");
  return (
    extractCsrfToken(await bookingPageHtml(slugs)) ?? (await signCsrfToken())
  );
};

/** POST `fields` under `<section>/<slugs>`, carrying the booking page's own
 * CSRF token. Booking and quoting post the same form to two sections. */
const postToBookingPath = async (
  section: string,
  slugs: string,
  fields: Record<string, string>,
): Promise<Response> => {
  const csrf = await bookingPageToken(slugs);
  return awaitTestRequest(`/${section}/${slugs}`, {
    cookie: `csrf_token=${csrf}`,
    data: { csrf_token: csrf, ...fields },
  });
};

/** POST a booking to `/ticket/<slugs>` with the given fields (CSRF auto-added). */
export const postBooking = (
  slugs: string,
  fields: Record<string, string>,
): Promise<Response> => postToBookingPath("ticket", slugs, fields);

/** POST a `/calculate/<slugs>` quote, returning the rendered HTML fragment. */
export const postCalculate = async (
  slugs: string,
  fields: Record<string, string>,
): Promise<string> =>
  (await postToBookingPath("calculate", slugs, fields)).text();

/** POST a booking to `/ticket/<slug>` with the standard test contact
 *  (`email: "a@b.com"`, `name: "Ada"`) merged into `fields`. The shared default
 *  behind every parent-gate booking so the email/name pair is declared once,
 *  not re-typed per test — `fields` overrides the defaults when a test needs a
 *  distinct contact (e.g. a second buyer). `slug` may be a compound
 *  `<a>+<b>` slugs string for multi-listing pages. */
export const bookParent = (
  slug: string,
  fields: Record<string, string>,
): Promise<Response> =>
  postBooking(slug, { email: "a@b.com", name: "Ada", ...fields });

/** Build the parent-quantity form field (`quantity_<id>`). */
export const parentField = (
  parent: Pick<Listing, "id">,
  qty: string,
): Record<string, string> => ({ [`quantity_${parent.id}`]: qty });

/** Build a child-quantity form field (`child_qty_<parentId>_<childId>`). */
export const childField = (
  parent: Pick<Listing, "id">,
  child: Pick<Listing, "id">,
  qty: string,
): Record<string, string> => ({ [`child_qty_${parent.id}_${child.id}`]: qty });

/** GET a JSON API path and return the raw Response. */
export const apiGet = async (path: string): Promise<Response> =>
  awaitTestRequest(path);

/** GET `/api/listings` (the collection endpoint) and return the row whose slug
 * matches `slug` — the single shape behind the "this parent is/isn't sold-out
 * in the collection list" tests, which were spelling out the GET + JSON parse +
 * `find` row-by-slug dance verbatim. */
export const apiListingRow = async (
  slug: string,
): Promise<{
  isSoldOut: boolean;
  maxPurchasable: number;
  slug: string;
}> => {
  const body = (await (await apiGet("/api/listings")).json()) as {
    listings: {
      isSoldOut: boolean;
      maxPurchasable: number;
      slug: string;
    }[];
  };
  const row = body.listings.find((l) => l.slug === slug);
  if (!row) {
    throw new Error(`apiListingRow: no listing with slug "${slug}" found`);
  }
  return row;
};

/** POST `/api/listings/<parent>/book` with a single child at qty 1 (the most
 * common folded-parent booking body), optionally spreading `extra` fields onto
 * the request (e.g. `date`). The shared shape behind the daily-parent-requires-
 * date, contact-fields, and sold-out-409 tests in the split. */
export const bookParentChild = (
  parent: { slug: string },
  child: { slug: string },
  extra: Record<string, unknown> = {},
): Promise<Response> =>
  apiBook(parent.slug, {
    children: [{ quantity: 1, slug: child.slug }],
    ...extra,
  });

/** GET `/api/listings/<slug>` and parse the `{ listing: T }` body, asserting a
 * 200. The single shape behind every "ordinary/parent listing API detail"
 * test: the GET + status + JSON parse + narrowing cast was repeated verbatim
 * across the parents-booking split and the bookable-alone suite, so it lives
 * once here. `T` defaults to the columns those suites actually read. */
export const listingDetail = async <
  T = { slug: string; maxPurchasable: number },
>(
  slug: string,
): Promise<{ listing: T }> => {
  const res = await apiGet(`/api/listings/${slug}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { listing: T };
};

/** The shape returned by `/api/listings/<slug>/availability` — top-level
 * availability plus the per-child breakdown (present when a parent has more
 * than one child). */
type AvailabilityBody = {
  available: boolean;
  children?: { slug: string; available: boolean }[];
};

/** GET `/api/listings/<slug>/availability` (optionally `?date=`) and parse the
 * `{ available, children? }` body, asserting a 200. Mirrors
 * {@link listingDetail} for the availability endpoint: the same GET + status +
 * JSON parse was repeated across the split's availability tests and the
 * bookable-alone suite. */
export const availabilityJson = async (
  slug: string,
  date?: string,
): Promise<AvailabilityBody> => {
  const path =
    date !== undefined
      ? `/api/listings/${slug}/availability?date=${date}`
      : `/api/listings/${slug}/availability`;
  const res = await apiGet(path);
  expect(res.status).toBe(200);
  return (await res.json()) as AvailabilityBody;
};

/** Assert a per-child availability response carries the expected
 * available/blocked pair (in any order): the same arrayContaining shape was
 * repeated across the inactive-child, closed-registration, and per-child
 * availability tests in the split. */
export const expectChildAvailability = (
  body: AvailabilityBody,
  okChild: { slug: string },
  blockedChild: { slug: string },
): void => {
  expect(body.children).toEqual(
    expect.arrayContaining([
      { available: true, slug: okChild.slug },
      { available: false, slug: blockedChild.slug },
    ]),
  );
};

/** GET a path with the public site enabled and return the raw Response. The
 * shared fetch behind {@link publicBody} and {@link ticketPageStatus}. */
const publicFetch = async (path: string): Promise<Response> => {
  await enablePublicSite();
  return awaitTestRequest(path);
};

/** Fetch a public page body with the public site enabled. Shared by the
 * discovery-suppression and bookable-alone surface suites. */
export const publicBody = async (path: string): Promise<string> =>
  (await publicFetch(path)).text();

/** Fetch a `/ticket/<slug>` page (public site enabled) and return its status,
 * draining the body — the shared standalone-page reachability probe. */
export const ticketPageStatus = async (slug: string): Promise<number> => {
  const response = await publicFetch(`/ticket/${slug}`);
  response.body?.cancel();
  return response.status;
};

/** POST `/api/listings/<slug>/book` with a minimal valid contact payload merged
 * with any extra body fields (e.g. `children`, `quantity`). */
export const apiBook = async (
  slug: string,
  extra: Record<string, unknown> = {},
): Promise<Response> =>
  handleRequest(
    new Request(`http://localhost/api/listings/${slug}/book`, {
      body: JSON.stringify({
        email: "a@b.com",
        name: "Ada",
        quantity: 1,
        ...extra,
      }),
      headers: { "content-type": "application/json", host: "localhost" },
      method: "POST",
    }),
  );

/** Assert a response is the public reservation success redirect. */
export const expectReserved = (response: Response): void => {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")!).toMatch(
    /^\/ticket\/reserved\?tokens=.+$/,
  );
};

/** Assert a booking was rejected at the parents gate: a 302 redirect, an error
 * flash (checked when `flash` is given), and zero attendee rows for
 * `listingId`. The shared tail of every parent-gate rejection test; callers
 * add extra child-row assertions after it. */
export const expectRejectedBooking = async (
  response: Response,
  listingId: number,
  flash?: string,
): Promise<void> => {
  expect(response.status).toBe(302);
  expectFlash(response, flash, false);
  await expectNoBooking({ id: listingId });
};

/** Assert a listing folded exactly one attendee line of `qty` — the shared
 * "one folded line of quantity N" persistence check behind the multi-child
 * fold tests. Delegates to {@link expectAttendeeCounts} (one-or-many: a
 * single folded line is a one-element list). Does NOT assert the redirect —
 * pair with {@link expectReserved} when the booking response is at hand. */
export const expectFoldedLine = (
  child: Pick<Listing, "id">,
  qty: number,
): Promise<void> =>
  expectAttendeeCounts([{ count: 1, listingId: child.id, quantity: qty }]);

/** Assert a listing has no attendee rows — the "the unchosen/sold-out child
 * was never booked" check behind the multi-child fold tests. Delegates to
 * {@link expectAttendeeCounts} (one-or-many: zero rows is a one-element list
 * with count 0). */
export const expectNoBooking = (child: Pick<Listing, "id">): Promise<void> =>
  expectAttendeeCounts([{ count: 0, listingId: child.id }]);

/** Book a parent at quantity 2 split 1 of `childA` + 1 of `childB`, then assert
 * both folded exactly one line of quantity 1 — the shared "1+1 fold" behind the
 * multi-child fold-acceptance test and the separate-pool combined-cap render
 * test that proves the selector matches the fold. */
export const bookOneOfEachFold = async (
  parent: Listing,
  childA: Listing,
  childB: Listing,
): Promise<void> => {
  const res = await bookParent(parent.slug, {
    ...childField(parent, childA, "1"),
    ...childField(parent, childB, "1"),
    ...parentField(parent, "2"),
  });
  expectReserved(res);
  await expectFoldedLine(childA, 1);
  await expectFoldedLine(childB, 1);
};

/** The slugs returned by `GET /api/listings`. */
export const apiListingSlugs = async (): Promise<string[]> => {
  const body = (await (await apiGet("/api/listings")).json()) as {
    listings: { slug: string }[];
  };
  return body.listings.map((l) => l.slug);
};

/** POST the children sub-form for a listing (`child_listing_ids[]`). */
export const postChildren = async (
  listingId: number,
  childIds: number[],
): Promise<Response> => {
  const { getTestSession } = await import("#test-utils/session.ts");
  const { cookie, csrfToken } = await getTestSession();
  return awaitTestRequest(`/admin/listing/${listingId}/children`, {
    cookie,
    data: {
      child_listing_ids: childIds.map(String),
      csrf_token: csrfToken,
    },
  });
};

/** GET an admin listing page (`/admin/listing/<id><suffix>`) as HTML. */
const adminListingHtml = async (
  listingId: number,
  suffix: string,
): Promise<string> => {
  const { adminGet } = await import("#test-utils/session.ts");
  const response = await adminGet(`/admin/listing/${listingId}${suffix}`);
  return response.text();
};

/** GET the admin listing EDIT page HTML. */
export const listingEditPageHtml = (listingId: number): Promise<string> =>
  adminListingHtml(listingId, "/edit");

/** GET the admin listing roster (Attendees tab) HTML — where the quick
 * add-attendee form and its required-child warning render. */
export const listingRosterPageHtml = (listingId: number): Promise<string> =>
  adminListingHtml(listingId, "/attendees");

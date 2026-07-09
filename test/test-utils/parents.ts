/**
 * Shared test helpers for the parent/child listings feature.
 *
 * Two kinds of duplication lived inline across the `server-parents-*` and
 * `server-listing-parents` suites: the same HTTP request helpers (book a ticket,
 * post a quote, hit the JSON API, save children) re-declared per file, and the
 * same imperative scenario setup (`createTestListing` ×N + `setChildIds`)
 * repeated hundreds of times. Both live here once.
 *
 * {@link makeParent} is the declarative scenario builder: describe a parent, its
 * children, and (optionally) a shared capped group, and get back the created
 * rows with the parent→child edges already wired — so a test states the
 * relationship it needs instead of assembling it line by line.
 */

import { expect } from "@std/expect";
import { listingChildren } from "#shared/db/listing-parents.ts";
import type { Group, Listing } from "#shared/types.ts";
import { createTestAttendee } from "./db-helpers/attendees.ts";
import { createTestGroup } from "./db-helpers/groups.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "./db-helpers/listings.ts";
import { enablePublicSite } from "./settings.ts";

// ---------------------------------------------------------------------------
// HTTP request helpers (one definition, shared by every parent suite)
// ---------------------------------------------------------------------------

/** GET `/ticket/<slugs>` and return the raw Response. */
export const ticketGet = async (slugs: string): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest } = await import("#test-utils/mocks.ts");
  return handleRequest(mockRequest(`/ticket/${slugs}`));
};

/** GET the booking-page HTML for `slugs`. */
export const bookingPageHtml = async (slugs: string): Promise<string> =>
  (await ticketGet(slugs)).text();

/** A CSRF token for posting to `/ticket/<slugs>`. Prefers the token embedded in
 * the rendered form; when the page renders no form (e.g. a parent projected to
 * sold-out because it has no bookable child), falls back to a freshly-minted
 * token so the submit-side gate can still be exercised. */
export const bookingPageToken = async (slugs: string): Promise<string> => {
  const { getTicketCsrfToken } = await import("#test-utils/csrf.ts");
  const { signCsrfToken } = await import("#shared/csrf.ts");
  return (
    getTicketCsrfToken(await bookingPageHtml(slugs)) ?? (await signCsrfToken())
  );
};

/** POST a booking to `/ticket/<slugs>` with the given fields (CSRF auto-added). */
export const postBooking = async (
  slugs: string,
  fields: Record<string, string>,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  const csrf = await bookingPageToken(slugs);
  return handleRequest(
    mockFormRequest(
      `/ticket/${slugs}`,
      { csrf_token: csrf, ...fields },
      `csrf_token=${csrf}`,
    ),
  );
};

/** POST a `/calculate/<slugs>` quote, returning the rendered HTML fragment. */
export const postCalculate = async (
  slugs: string,
  fields: Record<string, string>,
): Promise<string> => {
  const { handleRequest } = await import("#routes");
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  const csrf = await bookingPageToken(slugs);
  const res = await handleRequest(
    mockFormRequest(
      `/calculate/${slugs}`,
      { csrf_token: csrf, ...fields },
      `csrf_token=${csrf}`,
    ),
  );
  return res.text();
};

/** GET a JSON API path and return the raw Response. */
export const apiGet = async (path: string): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  return handleRequest(
    new Request(`http://localhost${path}`, { headers: { host: "localhost" } }),
  );
};

/** GET `/api/listings` (the collection endpoint) and return the row whose slug
 *  matches `slug` — the single shape behind the "this parent is/isn't sold-out
 *  in the collection list" tests, which were spelling out the GET + JSON parse +
 *  `find` row-by-slug dance verbatim. */
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
 *  common folded-parent booking body), optionally spreading `extra` fields onto
 *  the request (e.g. `date`). The shared shape behind the daily-parent-requires-
 *  date, contact-fields, and sold-out-409 tests in the split. */
export const bookParentChild = (
  parent: { slug: string },
  child: { slug: string },
  extra: Record<string, unknown> = {},
): Promise<Response> =>
  apiBook(parent.slug, {
    children: [{ quantity: 1, slug: child.slug }],
    ...extra,
  });

/** Build a parent with two children and deactivate the second: the shared
 *  "inactive child has spare capacity but the booking fold rejects it"
 *  scenario. Returns the parent, the active child, and the deactivated child
 *  so detail/availability assertions can name the bookable side. */
export const makeParentWithDeactivatedChild = async (): Promise<{
  inactiveChild: Listing;
  okChild: Listing;
  parent: Listing;
}> => {
  const { parent, children } = await makeParent({ children: [{}, {}] });
  const okChild = children[0]!;
  const inactiveChild = children[1]!;
  const { execute } = await import("#shared/db/client.ts");
  await execute("UPDATE listings SET active = 0 WHERE id = ?", [
    inactiveChild.id,
  ]);
  return { inactiveChild, okChild, parent };
};

/** GET `/api/listings/<slug>` and parse the `{ listing: T }` body, asserting a
 *  200. The single shape behind every "ordinary/parent listing API detail"
 *  test: the GET + status + JSON parse + narrowing cast was repeated verbatim
 *  across the parents-booking split and the bookable-alone suite, so it lives
 *  once here. `T` defaults to the columns those suites actually read. */
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
 *  availability plus the per-child breakdown (present when a parent has more
 *  than one child). */
type AvailabilityBody = {
  available: boolean;
  children?: { slug: string; available: boolean }[];
};

/** GET `/api/listings/<slug>/availability` (optionally `?date=`) and parse the
 *  `{ available, children? }` body, asserting a 200. Mirrors
 *  {@link listingDetail} for the availability endpoint: the same GET + status +
 *  JSON parse was repeated across the split's availability tests and the
 *  bookable-alone suite. */
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
 *  available/blocked pair (in any order): the same arrayContaining shape was
 *  repeated across the inactive-child, closed-registration, and per-child
 *  availability tests in the split. */
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
  const { handleRequest } = await import("#routes");
  const { mockRequest } = await import("#test-utils/mocks.ts");
  return handleRequest(mockRequest(path));
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
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  return handleRequest(
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
};

/** Assert a response is the public reservation success redirect. */
export const expectReserved = (response: Response): void => {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")!).toMatch(
    /^\/ticket\/reserved\?tokens=.+$/,
  );
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
  const { handleRequest } = await import("#routes");
  const { cookie, csrfToken } = await getTestSession();
  const body = new URLSearchParams();
  body.set("csrf_token", csrfToken);
  for (const id of childIds) body.append("child_listing_ids", String(id));
  return handleRequest(
    new Request(`http://localhost/admin/listing/${listingId}/children`, {
      body: body.toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        host: "localhost",
      },
      method: "POST",
    }),
  );
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
 *  add-attendee form and its required-child warning render. */
export const listingRosterPageHtml = (listingId: number): Promise<string> =>
  adminListingHtml(listingId, "/attendees");

// ---------------------------------------------------------------------------
// Declarative scenario builder
// ---------------------------------------------------------------------------

/** One listing in a {@link makeParent} spec: the usual `createTestListing`
 * overrides, plus `daily: true` to create it through `createDailyTestListing`. */
type ListingSpec = Parameters<typeof createTestListing>[0] & {
  daily?: boolean;
};

const makeListing = (
  spec: ListingSpec = {},
  fallbackName: string,
): Promise<Listing> => {
  const { daily, ...overrides } = spec;
  const input = { name: fallbackName, ...overrides };
  return daily ? createDailyTestListing(input) : createTestListing(input);
};

/**
 * Create a parent listing, its required children, and the parent→child edges in
 * one declarative call. A parent defaults to an empty thank-you URL (so a
 * completed booking lands on the public reservation page, which most gate tests
 * assert) and `children` defaults to a single child.
 *
 * `group`, when given, creates one capped group shared by the parent AND every
 * child (the common "parent + child contend for the same pool" shape, invariant
 * I7); a child spec can still set its own `groupId` to opt into a different
 * (e.g. child-only) group.
 */
export const makeParent = async (
  spec: {
    parent?: ListingSpec;
    children?: ListingSpec[];
    group?: Parameters<typeof createTestGroup>[0];
  } = {},
): Promise<{
  parent: Listing;
  /** The first (and, for the common single-child scenario, only) child — a
   * convenience so a test can `const { parent, child } = await makeParent(...)`
   * instead of reaching into `children[0]`. */
  child: Listing;
  children: Listing[];
  group?: Group | undefined;
}> => {
  const group = spec.group ? await createTestGroup(spec.group) : undefined;
  const groupId = group?.id;
  const withGroup = (s: ListingSpec): ListingSpec =>
    groupId !== undefined && s.groupId === undefined ? { groupId, ...s } : s;

  const parent = await makeListing(
    withGroup({ thankYouUrl: "", ...spec.parent }),
    "Parent",
  );
  const childSpecs = spec.children ?? [{}];
  const children: Listing[] = [];
  for (let i = 0; i < childSpecs.length; i++) {
    children.push(
      await makeListing(withGroup(childSpecs[i]!), `Child ${i + 1}`),
    );
  }
  await listingChildren.setIds(
    parent.id,
    children.map((c) => c.id),
  );
  return { child: children[0]!, children, group, parent };
};

/**
 * Build the "a group whose only standalone member is a sold-out parent"
 * scenario shared by the `/listings` CTA suppression and the group-QR 404
 * tests: a `createTestGroup` + parent placed in that group + a single-spot
 * child sold out via `createTestAttendee`, with the parent→child edge wired.
 * Both the CTA-suppression and the QR-404 paths exercise the same dead-member
 * setup, so it lives once here — only the group name (for assertion clarity)
 * varies between callers.
 */
export const soldOutParentInGroup = async (
  groupName: string,
): Promise<{ child: Listing; group: Group; parent: Listing }> => {
  const group = await createTestGroup({ name: groupName });
  const parent = await createTestListing({
    groupId: group.id,
    name: "Base in group",
  });
  const child = await createTestListing({
    maxAttendees: 1,
    name: "Sold-out add-on",
  });
  await createTestAttendee(child.id, child.slug, "Buyer", "b@x.com");
  await listingChildren.setIds(parent.id, [child.id]);
  return { child, group, parent };
};

/**
 * Enable the public site and assert `/listings` does NOT advertise a Book CTA
 * pointing at `groupSlug` — i.e. the dead-group link the page must not render.
 * The shared shape behind the two `/listings` CTA-suppression tests: turn the
 * site on, GET `/listings`, assert the `href="/ticket/<group>"` link is absent.
 */
export const expectNoListingsCta = async (groupSlug: string): Promise<void> => {
  await enablePublicSite();
  const { handleRequest } = await import("#routes");
  const body = await (
    await handleRequest(
      new Request("http://localhost/listings", {
        headers: { host: "localhost" },
      }),
    )
  ).text();
  expect(body).not.toContain(`href="/ticket/${groupSlug}"`);
};

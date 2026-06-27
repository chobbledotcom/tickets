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
import { setChildIds } from "#shared/db/listing-parents.ts";
import type { Group, Listing } from "#shared/types.ts";
import {
  createDailyTestListing,
  createTestGroup,
  createTestListing,
} from "#test-utils/db-helpers.ts";

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

/** GET the admin listing DETAIL page HTML. */
export const listingDetailPageHtml = (listingId: number): Promise<string> =>
  adminListingHtml(listingId, "");

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
  group?: Group;
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
  await setChildIds(
    parent.id,
    children.map((c) => c.id),
  );
  return { child: children[0]!, children, group, parent };
};

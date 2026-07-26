import { afterEach } from "@std/testing/bdd";
import { buildTicketListing } from "#shared/booking/model.ts";
import type { PagePackage } from "#shared/booking/page-packages.ts";
import { detectIframeMode } from "#shared/iframe.ts";
import { ticketPage } from "#templates/public/reservations/ticket-page.tsx";
import { pagePackage as sharedPagePackage } from "#test/test-utils/package-cap-fixtures.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

/** A ticket-page listing row built from column overrides (not hidden, no
 * per-attendee override) — the shape almost every ticketPage test needs. */
export const ticketListing = (
  overrides: Parameters<typeof testListingWithCount>[0],
): ReturnType<typeof buildTicketListing> =>
  buildTicketListing(testListingWithCount(overrides), false, undefined);

/** Two capped package members, "Big" (id 1) and "Small" (id 2). */
export const bigAndSmallListings = () => [
  ticketListing({
    attendee_count: 0,
    id: 1,
    max_attendees: 100,
    max_quantity: 10,
    name: "Big",
    slug: "big01",
  }),
  ticketListing({
    attendee_count: 0,
    id: 2,
    max_attendees: 100,
    max_quantity: 10,
    name: "Small",
    slug: "sml01",
  }),
];

/** A second listing "Listing B" (id 2, slug cd34e) with room for 50. */
export const listingB = () =>
  ticketListing({
    attendee_count: 50,
    id: 2,
    max_attendees: 50,
    name: "Listing B",
    slug: "cd34e",
  });

/** A package over group 7 taking one of each member per package. */
export const evenSplitPackages = () => [
  pagePackage(7, [1, 2], {
    quantities: new Map([
      [1, 1],
      [2, 1],
    ]),
  }),
];

/** Render the ticket page for a single "Listing A" plus any extra props. */
export const singleListingPageHtml = (
  extra: Partial<Parameters<typeof ticketPage>[0]> = {},
): string =>
  ticketPage({
    listings: [
      ticketListing({
        attendee_count: 0,
        id: 1,
        name: "Listing A",
        slug: "ab12c",
      }),
    ],
    slugs: ["ab12c"],
    ...extra,
  });

/** This suite's package pages share one slug so each test's `slugs` array can
 * name the package page. Delegates to the shared fixture; only the stable
 * display defaults differ. */
export const PKG_SLUG = "pkg-slug";
export const pagePackage = (
  groupId: number,
  memberListingIds: number[],
  overrides: Partial<PagePackage> = {},
): PagePackage =>
  sharedPagePackage(groupId, memberListingIds, {
    name: "Package",
    slug: PKG_SLUG,
    ...overrides,
  });

/** Reset iframe mode after each public-template test. */
/** Call it as the first statement INSIDE each top-level describe — at module
 * level it would register *global* hooks, which cannot be added once any
 * other module's tests exist (files share an isolate under the grouped
 * runner). */
export const registerPublicTemplateHooks = (): void => {
  afterEach(() => {
    detectIframeMode(new URL("https://example.com/"));
  });
};

/** Shared state helpers for fresh-process cold-start benchmarks. */

import { requiredMapValue } from "#fp";
import type { SitePage } from "#types";

export const BENCHMARK_REGULAR_GROUPS = 12;
export const BENCHMARK_PACKAGE_GROUPS = 2;
export const BENCHMARK_ROBOTS_BODY =
  "User-agent: *\nAllow: /listings/\nDisallow: /\n";
export const BENCHMARK_ROBOTS_CONTENT_TYPE = "text/plain; charset=utf-8";

const numberedName = (kind: string, number: number): string =>
  `Benchmark ${kind} ${String(number).padStart(2, "0")}`;

export const benchmarkGroupName = (
  number: number,
  isPackage: boolean,
): string => numberedName(isPackage ? "package" : "group", number);

export const benchmarkListingName = (number: number): string =>
  numberedName("listing", number);

export const benchmarkCatalogueMarkers = (): string[] => [
  ...Array.from({ length: BENCHMARK_REGULAR_GROUPS }, (_, index) =>
    benchmarkGroupName(index + 1, false),
  ),
  ...Array.from({ length: BENCHMARK_PACKAGE_GROUPS }, (_, index) =>
    benchmarkGroupName(BENCHMARK_REGULAR_GROUPS + index + 1, true),
  ),
  ...Array.from(
    { length: BENCHMARK_REGULAR_GROUPS + BENCHMARK_PACKAGE_GROUPS },
    (_, index) => benchmarkListingName(index + 1),
  ),
];

/** The booking page the booking-nav scenario serves: the first benchmark
 * listing's own page. */
export const BENCHMARK_BOOKING_SLUG = "benchmark-listing-1";

/** The site pages the booking-nav scenario's tree carries; the markers quote
 * the root page's rendered link. */
export const BENCHMARK_NAV_PAGES = {
  extras: { name: "Extras", slug: "benchmark-nav-extras" },
  visit: { name: "Visit", slug: "benchmark-nav-visit" },
} as const;

/** The exact anchor NodeLink renders for an active chain node. */
const activeLink = (href: string, label: string): string =>
  `<a class="active" href="${href}">${label}</a>`;

/** The booking page's completeness markers: its own form for the seeded
 * listing, and the active nav chain it highlights — the Visit root page and
 * the listing itself. A page that rendered no navigation fails these. */
export const benchmarkBookingMarkers = (): string[] => [
  benchmarkListingName(1),
  `action="/ticket/${BENCHMARK_BOOKING_SLUG}"`,
  activeLink(
    `/page/${BENCHMARK_NAV_PAGES.visit.slug}`,
    BENCHMARK_NAV_PAGES.visit.name,
  ),
  activeLink(`/ticket/${BENCHMARK_BOOKING_SLUG}`, benchmarkListingName(1)),
];

/** Require the response rendered every marker, so a faster partial page
 * cannot count as a valid benchmark sample. */
export const requireMarkers = (
  response: { body: string; status: number },
  what: string,
  markers: readonly string[],
): void => {
  if (response.status !== 200) {
    throw new Error(`${what} failed with status ${response.status}`);
  }
  const missing = markers.filter((marker) => !response.body.includes(marker));
  if (missing.length > 0) {
    throw new Error(`${what} did not render ${missing.join(", ")}`);
  }
};

const rotate = <T>(items: readonly T[], offset: number): T[] => [
  ...items.slice(offset),
  ...items.slice(0, offset),
];

/** Rotate one full cycle forward and the next in reverse. With two cycles,
 * every item occupies every position twice and every pair's order is balanced. */
export const balancedRotation = <T>(items: readonly T[], run: number): T[] => {
  const cycle = Math.floor(run / items.length);
  const order = cycle % 2 === 0 ? items : items.toReversed();
  return rotate(order, run % items.length);
};

export const balancedCycles = <T>(
  runs: readonly T[],
  positionsPerCycle: number,
): T[][] => {
  if (runs.length % positionsPerCycle !== 0) {
    throw new Error(
      `Run count ${runs.length} must be a multiple of positions per cycle ${positionsPerCycle}`,
    );
  }
  return Array.from({ length: runs.length / positionsPerCycle }, (_, cycle) =>
    runs.slice(cycle * positionsPerCycle, (cycle + 1) * positionsPerCycle),
  );
};

export const requiredEnv = (key: string): string => {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`${key} is required`);
  return value;
};

export const samplesFor = <Key, Sample>(
  samples: ReadonlyMap<Key, Sample[]>,
  key: Key,
): Sample[] => {
  const found = samples.get(key);
  if (!found) throw new Error(`Samples missing for ${String(key)}`);
  return found;
};

/** The ids the catalogue seeding created, by their benchmark number. */
export type BenchmarkCatalogueIds = {
  groupIds: ReadonlyMap<number, number>;
  listingIds: ReadonlyMap<number, number>;
};

/** Add the public catalogue whose group count makes query scaling visible.
 * Dynamic imports: nothing may read the environment before main sets it. */
export const seedBenchmarkCatalogue =
  async (): Promise<BenchmarkCatalogueIds> => {
    const { groups, setListingGroups } = await import("#db/groups.ts");
    const { listingsTable } = await import("#db/listings/records.ts");
    const { hmacHash } = await import("#crypto/hashing.ts");

    const groupIds = new Map<number, number>();
    const listingIds = new Map<number, number>();
    const addGroupWithListing = async (
      number: number,
      isPackage: boolean,
    ): Promise<void> => {
      const kind = isPackage ? "package" : "group";
      const slug = `benchmark-${kind}-${number}`;
      const group = await groups.table.insert({
        isPackage,
        name: benchmarkGroupName(number, isPackage),
        slug,
        slugIndex: await hmacHash(slug),
      });
      const listingSlug = `benchmark-listing-${number}`;
      const listing = await listingsTable.insert({
        maxAttendees: 100,
        maxPrice: 0,
        name: benchmarkListingName(number),
        slug: listingSlug,
        slugIndex: await hmacHash(listingSlug),
      });
      await setListingGroups(listing.id, [group.id]);
      groupIds.set(number, group.id);
      listingIds.set(number, listing.id);
    };

    for (let number = 1; number <= BENCHMARK_REGULAR_GROUPS; number++) {
      await addGroupWithListing(number, false);
    }
    for (let number = 1; number <= BENCHMARK_PACKAGE_GROUPS; number++) {
      await addGroupWithListing(BENCHMARK_REGULAR_GROUPS + number, true);
    }
    return { groupIds, listingIds };
  };

/** Seed the site-page tree the booking-nav scenario reads: a root page
 * carrying two benchmark listings, and a page nested under it carrying one
 * group. The group sits off the active chain a listing's booking page
 * highlights, so the nav's unscoped leaf resolution pays for a page the
 * model never shows. Dynamic imports: nothing may read the environment
 * before main sets it. */
export const seedBenchmarkNavTree = async (
  ids: BenchmarkCatalogueIds,
): Promise<void> => {
  const { createSitePage, sitePages } = await import("#db/site-pages.ts");
  const { addPageItem, invalidatePageItemsCache } = await import(
    "#db/site-page-items.ts"
  );

  const addPage = async (name: string, slug: string): Promise<SitePage> => {
    const result = await createSitePage({
      content: "",
      hidden: false,
      metaDescription: "",
      metaTitle: "",
      name,
      slug,
    });
    if (!result.ok) throw new Error(`site page slug is already used: ${slug}`);
    return result.value;
  };

  // createSitePage orders root pages by creation, so Visit roots first.
  const visit = await addPage(
    BENCHMARK_NAV_PAGES.visit.name,
    BENCHMARK_NAV_PAGES.visit.slug,
  );
  const extras = await addPage(
    BENCHMARK_NAV_PAGES.extras.name,
    BENCHMARK_NAV_PAGES.extras.slug,
  );
  await addPageItem(visit.id, "page", extras.id);
  await addPageItem(
    visit.id,
    "listing",
    requiredMapValue(ids.listingIds, 1, "Missing benchmark listing 1"),
  );
  await addPageItem(
    visit.id,
    "listing",
    requiredMapValue(ids.listingIds, 2, "Missing benchmark listing 2"),
  );
  await addPageItem(
    extras.id,
    "group",
    requiredMapValue(ids.groupIds, 1, "Missing benchmark group 1"),
  );
  // The page tree's reads cache per process; drop the warmed entries so a
  // later request in this same prep process reads the seeded edges.
  sitePages.invalidate();
  invalidatePageItemsCache();
};

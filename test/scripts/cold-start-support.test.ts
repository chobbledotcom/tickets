import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import { groups } from "#db/groups.ts";
import { getAllListings } from "#db/listings/records.ts";
import { getAllPageItems } from "#db/site-page-items.ts";
import { sitePages } from "#db/site-pages.ts";
import { emptyListsFor } from "#fp";
import {
  BENCHMARK_BOOKING_SLUG,
  BENCHMARK_NAV_PAGES,
  BENCHMARK_PACKAGE_GROUPS,
  BENCHMARK_REGULAR_GROUPS,
  balancedCycles,
  balancedRotation,
  benchmarkBookingMarkers,
  benchmarkCatalogueMarkers,
  benchmarkGroupName,
  benchmarkListingName,
  requiredEnv,
  requireMarkers,
  samplesFor,
  seedBenchmarkCatalogue,
  seedBenchmarkNavTree,
} from "#scripts/bench/cold-start/support.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { withEnv } from "#test-utils/env.ts";
import type { SitePageItemType } from "#types";

const completeCatalogueBody = (): string =>
  benchmarkCatalogueMarkers().join("\n");

describe("cold-start benchmark support", () => {
  test("balancedCycles rejects a partial measurement cycle", () => {
    expect(() => balancedCycles([1, 2, 3, 4, 5], 4)).toThrow(
      "Run count 5 must be a multiple of positions per cycle 4",
    );
  });

  test("balancedCycles keeps every complete measurement cycle", () => {
    expect(balancedCycles([1, 2, 3, 4, 5, 6], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  test("balancedRotation balances positions and pair order", () => {
    const items = ["a", "b", "c"];
    expect(
      Array.from({ length: 6 }, (_, run) => balancedRotation(items, run)),
    ).toEqual([
      ["a", "b", "c"],
      ["b", "c", "a"],
      ["c", "a", "b"],
      ["c", "b", "a"],
      ["b", "a", "c"],
      ["a", "c", "b"],
    ]);
  });

  test("requireMarkers accepts the complete seeded page", () => {
    expect(() =>
      requireMarkers(
        { body: completeCatalogueBody(), status: 200 },
        "request",
        benchmarkCatalogueMarkers(),
      ),
    ).not.toThrow();
  });

  test("requireMarkers rejects an error response", () => {
    expect(() =>
      requireMarkers(
        { body: "", status: 500 },
        "request",
        benchmarkCatalogueMarkers(),
      ),
    ).toThrow("request failed with status 500");
  });

  test("requireMarkers rejects a partial catalogue", () => {
    expect(() =>
      requireMarkers(
        {
          body: completeCatalogueBody().replace("Benchmark listing 14", ""),
          status: 200,
        },
        "request",
        benchmarkCatalogueMarkers(),
      ),
    ).toThrow("request did not render Benchmark listing 14");
  });

  test("requireMarkers rejects a booking page without the active nav chain", () => {
    // The form markers alone: a page that dropped the navigation.
    const body = benchmarkBookingMarkers().slice(0, 2).join("\n");
    expect(() =>
      requireMarkers(
        { body, status: 200 },
        "booking request",
        benchmarkBookingMarkers(),
      ),
    ).toThrow(
      `booking request did not render <a class="active" href="/page/benchmark-nav-visit">Visit</a>`,
    );
  });

  test("requiredEnv returns a configured value", () => {
    const key = "COLD_START_SUPPORT_TEST";
    using _env = withEnv({ [key]: "configured" });
    expect(requiredEnv(key)).toBe("configured");
  });

  test("requiredEnv rejects a missing value", () => {
    const key = "COLD_START_SUPPORT_MISSING_TEST";
    using _env = withEnv({ [key]: undefined });
    expect(() => requiredEnv(key)).toThrow(`${key} is required`);
  });

  test("emptyListsFor stores samples for each requested key", () => {
    const samples = emptyListsFor<string, number>(["cold", "warm"]);
    samplesFor(samples, "cold").push(42);
    expect(samplesFor(samples, "cold")).toEqual([42]);
    expect(samplesFor(samples, "warm")).toEqual([]);
  });

  test("samplesFor rejects an unknown key", () => {
    expect(() => samplesFor(emptyListsFor(["cold"]), "warm")).toThrow(
      "Samples missing for warm",
    );
  });
});

describeWithEnv("cold-start benchmark seeding", { db: true }, () => {
  test("seedBenchmarkCatalogue inserts one group and one listing per number", async () => {
    const ids = await seedBenchmarkCatalogue();
    const total = BENCHMARK_REGULAR_GROUPS + BENCHMARK_PACKAGE_GROUPS;
    expect(ids.groupIds.size).toBe(total);
    expect(ids.listingIds.size).toBe(total);

    const groupRows = await groups.cache.getAll();
    const listingRows = await getAllListings();
    expect(groupRows).toHaveLength(total);
    expect(listingRows).toHaveLength(total);

    // The packages continue the numbering after the regular groups.
    const group1 = groupRows.find((row) => row.id === ids.groupIds.get(1));
    expect(group1?.name).toBe(benchmarkGroupName(1, false));
    expect(group1?.is_package).toBe(false);
    const firstPackage = groupRows.find(
      (row) => row.id === ids.groupIds.get(BENCHMARK_REGULAR_GROUPS + 1),
    );
    expect(firstPackage?.name).toBe(
      benchmarkGroupName(BENCHMARK_REGULAR_GROUPS + 1, true),
    );
    expect(firstPackage?.is_package).toBe(true);

    const listing1 = listingRows.find(
      (row) => row.id === ids.listingIds.get(1),
    );
    expect(listing1?.name).toBe(benchmarkListingName(1));
    expect(listing1?.slug).toBe(BENCHMARK_BOOKING_SLUG);
  });

  test("seedBenchmarkNavTree wires the Visit chain and the off-chain Extras group", async () => {
    const ids = await seedBenchmarkCatalogue();
    await seedBenchmarkNavTree(ids);

    const pages = await sitePages.getAll();
    const visit = pages.find(
      (page) => page.slug === BENCHMARK_NAV_PAGES.visit.slug,
    );
    const extras = pages.find(
      (page) => page.slug === BENCHMARK_NAV_PAGES.extras.slug,
    );
    expect(visit?.name).toBe(BENCHMARK_NAV_PAGES.visit.name);
    expect(extras?.name).toBe(BENCHMARK_NAV_PAGES.extras.name);

    const items = await getAllPageItems();
    const idsOnPage = (
      pageId: number | undefined,
      itemType: SitePageItemType,
    ): (number | undefined)[] =>
      items
        .filter(
          (item) => item.page_id === pageId && item.item_type === itemType,
        )
        .map((item) => item.item_id);
    // Visit carries its child page and the two benchmark listings; Extras
    // carries the one group, off the chain a listing's page highlights.
    expect(idsOnPage(visit?.id, "page")).toEqual([extras?.id]);
    expect(idsOnPage(visit?.id, "listing")).toEqual([
      ids.listingIds.get(1),
      ids.listingIds.get(2),
    ]);
    expect(idsOnPage(extras?.id, "group")).toEqual([ids.groupIds.get(1)]);
  });

  test("seedBenchmarkNavTree refuses a page whose slug is already used", async () => {
    const ids = await seedBenchmarkCatalogue();
    await createTestSitePage(BENCHMARK_NAV_PAGES.visit.slug);
    await expect(seedBenchmarkNavTree(ids)).rejects.toThrow(
      `site page slug is already used: ${BENCHMARK_NAV_PAGES.visit.slug}`,
    );
  });
});

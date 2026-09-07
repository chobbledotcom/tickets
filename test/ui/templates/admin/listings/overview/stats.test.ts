import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ListingOverviewStats } from "#db/listing-overview-stats.ts";
import {
  overviewStatsFromAttendees,
  overviewStatsFromDbStats,
} from "#templates/admin/listings/overview.tsx";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

// Direct assertions on the two stat builders behind the Overview tab's
// numbers, with figures chosen so wrong arithmetic cannot land on the answer.
describe("overviewStatsFromAttendees", () => {
  test("reports zero complete revenue for a free listing", () => {
    const stats = overviewStatsFromAttendees(
      testListingWithCount({ attendee_count: 1, unit_price: 0 }),
      [testAttendee()],
    );
    expect(stats.completeRevenue).toBe(0);
  });
});

describe("overviewStatsFromDbStats", () => {
  const stats: ListingOverviewStats = {
    completeQuantitySum: 8,
    incompleteQuantity: 2,
    incompleteSales: 200,
    rowsCheckedIn: 1,
    rowsTotal: 3,
    ticketsCheckedIn: 2,
    ticketsTotal: 8,
  };

  test("subtracts the incomplete quantity from the attendee count", () => {
    expect(overviewStatsFromDbStats(stats, 10, 1000, true).adjustedCount).toBe(
      8,
    );
  });

  test("paid listing revenue is gross sales minus incomplete sales", () => {
    expect(
      overviewStatsFromDbStats(stats, 10, 1000, true).completeRevenue,
    ).toBe(800);
  });

  test("free listing revenue is zero whatever the sales figures say", () => {
    expect(
      overviewStatsFromDbStats(stats, 10, 1000, false).completeRevenue,
    ).toBe(0);
  });
});

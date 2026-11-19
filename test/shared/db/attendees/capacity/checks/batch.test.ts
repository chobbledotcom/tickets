import type { ResultSet, TransactionMode } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { BatchAvailabilityItem } from "#db/attendee-types.ts";
import {
  checkBatchAvailabilityImpl as checkBatchAvailability,
  checkLinesCapacity,
} from "#db/attendees/capacity/checks.ts";
import {
  addDemandToBucket,
  buildCartCapacitySql,
  type CapacityBucket,
  type CartDemand,
  getOrCreateBucket,
} from "#db/capacity-batch.ts";
import { getDb, queryOne } from "#db/client.ts";
import { enableQueryLog, getQueryLog } from "#db/query-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createListings,
  dailyListingBesideBookedStandard,
  dailyListingBooked,
  groupWithMembers,
  setStoredBookedQuantity,
} from "#test-utils/db-helpers/capacity-fixtures.ts";
import {
  createDailyTestListing,
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  emptyResultSet,
  stubResultSet,
} from "#test-utils/db-helpers/result-set.ts";
import { withEnv } from "#test-utils/env.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

describeWithEnv("db > attendees > checkBatchAvailability", { db: true }, () => {
  /** Run one cart through the preflight and assert its verdict. */
  const expectBatchFits = async (
    items: BatchAvailabilityItem[],
    fits: boolean,
    date?: string,
  ): Promise<void> => {
    expect(await checkBatchAvailability(items, date)).toBe(fits);
  };

  test("returns true for empty items", async () => {
    await expectBatchFits([], true);
  });

  test("returns each line result in request order", async () => {
    const [available, full] = await createListings({
      count: 2,
      maxAttendees: 1,
    });
    await bookAttendee(full!, { quantity: 1 });

    expect(
      await checkLinesCapacity([
        {
          date: null,
          durationDays: 1,
          listingId: available!.id,
          quantity: 1,
        },
        {
          date: null,
          durationDays: 1,
          listingId: full!.id,
          quantity: 1,
        },
      ]),
    ).toEqual([true, false]);
  });

  test("throws when a listing is not found", async () => {
    await expect(
      checkBatchAvailability([{ listingId: 999, quantity: 1 }]),
    ).rejects.toThrow("Listing not found: 999");
  });

  /** Each case is one daily listing, the days it is already full, and the
   * cart lines whose verdicts the preflight must give. */
  const dailyListingCases: {
    booked: { day: string; quantity: number }[];
    cap: number;
    cases: {
      cart: { durationDays?: number; quantity: number };
      date?: string;
      fits: boolean;
    }[];
    name: string;
    span?: number;
  }[] = [
    {
      booked: [{ day: "2026-05-01", quantity: 2 }],
      cap: 2,
      // One day is full; the day beside it still holds both places.
      cases: [
        { cart: { quantity: 1 }, date: "2026-05-01", fits: false },
        { cart: { quantity: 2 }, date: "2026-05-02", fits: true },
      ],
      name: "checks per-date capacity for daily listings",
    },
    {
      booked: [{ day: "2026-05-01", quantity: 2 }],
      cap: 2,
      // With no anchor date the listing's demand must fall back to its
      // date-less running total (2 booked + 1 > 2), not a per-day expansion
      // of a date that does not exist.
      cases: [{ cart: { quantity: 1 }, fits: false }],
      name: "a date-less batch counts a daily listing's running total",
    },
    {
      booked: [{ day: "2026-05-02", quantity: 2 }],
      cap: 2,
      // The middle day of the cart's span is already full.
      cases: [
        {
          cart: { durationDays: 3, quantity: 1 },
          date: "2026-05-01",
          fits: false,
        },
      ],
      name: "rejects a multi-day booking when any day in the range is at capacity",
      span: 3,
    },
    {
      booked: [],
      cap: 2,
      cases: [
        {
          cart: { durationDays: 3, quantity: 1 },
          date: "2026-05-01",
          fits: true,
        },
      ],
      name: "accepts a multi-day booking when every day has room",
      span: 3,
    },
    {
      booked: [
        { day: "2026-05-01", quantity: 2 },
        { day: "2026-05-03", quantity: 2 },
      ],
      cap: 2,
      // The first and last days of the span are full; the middle one is free.
      cases: [
        {
          cart: { durationDays: 1, quantity: 2 },
          date: "2026-05-02",
          fits: true,
        },
      ],
      name: "admits a 1-day booking in the gap between two full days",
      span: 3,
    },
  ];

  for (const { booked, cap, cases, name, span } of dailyListingCases) {
    test(name, async () => {
      const listing = await dailyListingBooked({
        booked,
        maxAttendees: cap,
        ...(span !== undefined && { durationDays: span }),
      });
      for (const { cart, date, fits } of cases) {
        await expectBatchFits([{ ...cart, listingId: listing.id }], fits, date);
      }
    });
  }

  test("a dated batch still counts a standard listing's demand as a running total", async () => {
    // The standard listing's prior booking lives only in its running total —
    // its rows carry no booking range, so a per-day count would never see it.
    const { daily, standard } = await dailyListingBesideBookedStandard({
      booked: 1,
      standardCap: 2,
    });
    // The date belongs to the daily item; the standard listing's demand must
    // still land on its running total (1 booked + 2 > 2), not in a per-day
    // bucket where the existing booking is invisible.
    for (const { fits, standardQuantity } of [
      { fits: false, standardQuantity: 2 },
      { fits: true, standardQuantity: 1 },
    ]) {
      await expectBatchFits(
        [
          { listingId: standard.id, quantity: standardQuantity },
          { listingId: daily.id, quantity: 1 },
        ],
        fits,
        "2026-05-01",
      );
    }
  });

  test("enforces group per-day cap across Saturday/Sunday/combo scenario", async () => {
    // Two one-day members and one two-day member of one group. The combo
    // booking spans Saturday and Sunday, so Saturday is full at 100 while
    // Sunday still holds 50.
    const { group, members } = await groupWithMembers({
      cap: 100,
      count: 2,
      daily: true,
    });
    const [sat, sun] = members;
    const combo = await createDailyTestListing({
      durationDays: 2,
      groupId: group.id,
      maxAttendees: 100,
    });
    await bookAttendee(sat!, { date: "2026-05-02", quantity: 50 });
    await bookAttendee(combo, {
      date: "2026-05-02",
      durationDays: 2,
      quantity: 50,
    });
    await expectBatchFits(
      [{ listingId: sat!.id, quantity: 1 }],
      false,
      "2026-05-02",
    );
    await expectBatchFits(
      [{ listingId: sun!.id, quantity: 50 }],
      true,
      "2026-05-03",
    );
  });

  test("an uncapped group never refuses a dated cart", async () => {
    // A package group's cap of 0 means no limit — the write's group clause
    // passes it, so the preflight's per-day clause must pass it too and not
    // read a 0 cap as "no place left".
    const { members } = await groupWithMembers({
      cap: 0,
      count: 1,
      daily: true,
      maxAttendees: 10,
    });
    await expectBatchFits(
      [{ durationDays: 2, listingId: members[0]!.id, quantity: 3 }],
      true,
      "2026-05-01",
    );
  });

  /** One more ticket on an already-full standard listing, checked against an
   * optional cart date — the running total must reject it either way. */
  const expectOneMoreRefused = async (date?: string): Promise<void> => {
    const listing = await createTestListing({
      listingType: "standard",
      maxAttendees: 2,
    });
    await bookAttendee(listing, { quantity: 2 });
    await expectBatchFits(
      [{ listingId: listing.id, quantity: 1 }],
      false,
      date,
    );
  };

  test("a dated cart still counts a standard listing's running total", async () => {
    // A standard listing's rows carry no booking range, so bucketing its
    // demand per-day would count an empty overlap and admit an over-cap cart.
    await expectOneMoreRefused("2026-05-01");
  });

  test("rejects negative quantities", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    await expectBatchFits([{ listingId: listing.id, quantity: -1 }], false);
  });

  test("treats a zero-quantity item as a no-op that fits", async () => {
    // A zero-quantity line demands nothing, so it produces no capacity clause
    // and the cart trivially fits — exercises the empty-demand path.
    const listing = await createTestListing({ maxAttendees: 1 });
    await bookAttendee(listing, { quantity: 1 });
    await expectBatchFits([{ listingId: listing.id, quantity: 0 }], true);
  });

  test("a zero-quantity line fits a dated daily listing that is over-full", async () => {
    // The listing's running total sits past its cap from earlier sales. A
    // line that books no places cannot make that worse, so the preflight
    // must not refuse it.
    const listing = await createDailyTestListing({ maxAttendees: 1 });
    await setStoredBookedQuantity(listing.id, 5);
    await expectBatchFits(
      [{ listingId: listing.id, quantity: 0 }],
      true,
      "2026-05-01",
    );
  });

  test("a zero-quantity line fits an inactive listing", async () => {
    // An inactive listing's cap subquery returns NULL. A line that demands
    // nothing carries no capacity clause, so the NULL cannot refuse it.
    const listing = await createTestListing({ maxAttendees: 1 });
    await deactivateTestListing(listing.id);
    await expectBatchFits([{ listingId: listing.id, quantity: 0 }], true);
  });

  test("a cart of twelve 90-day lines on one date stays inside the SQL depth limit", async () => {
    // One clause per listing-day would emit 12 x 90 ANDed clauses and pass
    // SQLite's expression-depth limit at checkout time. The grouped per-day
    // counting keeps the clause count at one per listing.
    const items = (
      await createListings({ count: 12, daily: true, maxAttendees: 5 })
    ).map((listing) => ({
      durationDays: 90,
      listingId: listing.id,
      quantity: 1,
    }));
    await expectBatchFits(items, true, "2026-05-01");
  });

  test("rejects a standard listing exceeding total capacity", async () => {
    await expectOneMoreRefused();
  });

  test("uses the editable booked quantity for standard listing capacity", async () => {
    const listing = await createTestListing({
      listingType: "standard",
      maxAttendees: 5,
    });
    await setStoredBookedQuantity(listing.id, 5);
    await expectBatchFits([{ listingId: listing.id, quantity: 1 }], false);
  });

  test("stays within a constant query budget for a large cart", async () => {
    // More daily listings than the N+1 read guard threshold (25): a per-listing
    // fan-out would run the occupancy read once each and trip the guard.
    const items = (
      await createListings({ count: 28, daily: true, maxAttendees: 5 })
    ).map((listing) => ({ listingId: listing.id, quantity: 1 }));
    await withRequestContext(async () => {
      enableQueryLog();
      await expectBatchFits(items, true, "2026-05-01");
      // Listing rows + batched occupancy + group caps — a small constant.
      expect(getQueryLog().length).toBeLessThanOrEqual(5);
    });
  });

  test("answers a built cart statement against real occupancy", async () => {
    // Reused numbered placeholders must be accepted by SQLite itself: two
    // buckets share the same day pair, so the statement reuses one ?N for it.
    const free = await createDailyTestListing({ maxAttendees: 2 });
    const full = await dailyListingBooked({
      booked: [{ day: "2026-05-01", quantity: 1 }],
      maxAttendees: 1,
    });
    const demandFor = (...listingIds: number[]): CartDemand => {
      const listingDemand = new Map<number, CapacityBucket>();
      for (const listingId of listingIds) {
        const bucket = getOrCreateBucket(listingDemand, listingId);
        addDemandToBucket(
          bucket,
          { listingType: "daily" },
          { listingId, quantity: 1 },
          "2026-05-01",
        );
      }
      return { groupDemand: new Map(), listingDemand };
    };

    // The free listing fits; the statement runs and returns one row.
    const fits = buildCartCapacitySql(demandFor(free.id));
    expect(await queryOne<{ fits: number }>(fits)).toEqual({
      fits: 1,
    });

    // A cart carrying both listings does not fit: the full one is over cap.
    const both = buildCartCapacitySql(demandFor(free.id, full.id));
    expect(await queryOne<{ fits: number }>(both)).toEqual({
      fits: 0,
    });
  });

  test("reads on the primary, so a lagging replica cannot reject a fitting cart", async () => {
    // Production callers treat `false` as final — the submit paths answer
    // with the sold-out form error — so a replica that has not replayed a
    // cancellation yet must not decide the verdict. Every preflight read
    // pins to the primary, which a write-mode batch names.
    const answerFor = (sql: string): ResultSet => {
      if (sql.includes("AS fits")) return stubResultSet([{ fits: 1 }]);
      if (sql.includes("FROM listings AS listing")) {
        return stubResultSet([
          {
            attendee_count: 0,
            id: 501,
            listing_type: "standard",
            max_attendees: 10,
          },
        ]);
      }
      return emptyResultSet();
    };
    const modes: string[] = [];
    using _env = withEnv({ DB_URL: "http://primary.example" });
    const batchStub = stub(
      getDb(),
      "batch",
      (statements: unknown, mode?: TransactionMode) => {
        modes.push(mode ?? "");
        return Promise.resolve(
          (statements as { sql: string }[]).map(({ sql }) => answerFor(sql)),
        );
      },
    );
    try {
      await expectBatchFits([{ listingId: 501, quantity: 1 }], true);
    } finally {
      batchStub.restore();
    }
    // Listing rows, group membership, fit verdict — one primary batch each.
    expect(modes).toEqual(["write", "write", "write"]);
  });
});

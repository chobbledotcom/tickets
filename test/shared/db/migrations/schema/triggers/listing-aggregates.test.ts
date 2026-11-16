import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { allTransfers } from "#accounting/queries.ts";
import { attendeeListingContributionsSql } from "#db/attendees/delete.ts";
import { getDb } from "#db/client.ts";
import {
  adjustListingIncome,
  getListingAggregateRecalculation,
  listingAggregates,
} from "#db/listings/aggregates.ts";
import {
  getListingWithCount,
  invalidateListingsCache,
} from "#db/listings/records.ts";
import { loadMigrations } from "#db/migrations/context.ts";
import {
  LISTING_AGGREGATE_WRITE_COLUMNS,
  TICKET_COUNTS_PREDICATE,
} from "#db/migrations/schema/listing-aggregates.ts";
import { TRIGGERS } from "#db/migrations/schema/triggers.ts";
import { BACKFILL_LISTING_AGGREGATES_SQL } from "#db/migrations/schema-sync.ts";
import { sql } from "#db/sql.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger/record.ts";
import {
  type AggregateRows,
  type AggregateStepsCase,
  describeAggregateTriggerCases,
  seedAggregateRows,
  sharedAggregateTriggerCases,
} from "#test-utils/db/aggregate-trigger-cases.ts";
import { readListingAggregates as aggregates } from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";

const MIGRATIONS = await loadMigrations();
const refundPostedSale = async (
  listingId: number,
  attendeeId: number,
): Promise<void> => {
  await recordAttendeeRefund(attendeeId, [
    {
      index: `sale-${listingId}-${attendeeId}`,
      sessionIds: [`sale-${listingId}-${attendeeId}`],
    },
  ]);
};

/** The rows the listing_attendees triggers count. */
const ATTENDEE_ROWS: AggregateRows = {
  parent: "listing_id",
  table: "listing_attendees",
};

/** A no-quantity sentinel line must bump neither tickets_count nor
 * booked_quantity (income is ledger-projected and tested separately). */
const QUANTITY_ZERO_INSERT: AggregateStepsCase = {
  name: "inserting a quantity-0 line counts toward neither ticket count nor capacity",
  seed: [
    [1, 2],
    [2, 0],
  ],
  steps: [{ expected: { booked_quantity: 2, tickets_count: 1 } }],
};

/** The UPDATE trigger adds and removes a ticket as the quantity crosses zero. */
const ZERO_TOGGLE: AggregateStepsCase = {
  name: "toggling a line 0->n and n->0 moves tickets_count and capacity together",
  seed: [[1, 0]],
  steps: [
    { expected: { booked_quantity: 0, tickets_count: 0 } },
    {
      expected: { booked_quantity: 4, tickets_count: 1 },
      write: (writes, parentId) => writes.set(parentId, 1, "quantity", 4),
    },
    {
      expected: { booked_quantity: 0, tickets_count: 0 },
      write: (writes, parentId) => writes.set(parentId, 1, "quantity", 0),
    },
  ],
};

/** A ghost line contributes no ticket, so deleting it moves no count. */
const QUANTITY_ZERO_DELETE: AggregateStepsCase = {
  name: "deleting a quantity-0 line leaves tickets_count unchanged",
  seed: [
    [1, 2],
    [2, 0],
  ],
  steps: [
    {
      expected: { booked_quantity: 2, tickets_count: 1 },
      write: (writes, parentId) => writes.remove(parentId, 2),
    },
  ],
};

describe("LISTING_AGGREGATE_WRITE_COLUMNS matches the trigger SQL", () => {
  test("the UPDATE trigger fires on exactly the columns in LISTING_AGGREGATE_WRITE_COLUMNS", () => {
    const updateTrigger = TRIGGERS.find(
      (t) => t.name === "trg_listing_attendees_aggregates_update",
    );
    const expectedCols = [...LISTING_AGGREGATE_WRITE_COLUMNS].join(", ");
    assertStringIncludes(
      updateTrigger!.sql.sql,
      `AFTER UPDATE OF ${expectedCols} ON listing_attendees`,
    );
  });
});

describe("tickets_count shared predicate guard", () => {
  // tickets_count must count only quantity > 0 rows. The predicate lives in one
  // place (TICKET_COUNTS_PREDICATE); every site that computes tickets_count must
  // reference it, or the recalculate/repair flow would fight the triggers. This
  // asserts the shared predicate appears in the exported schema SQL. Listing
  // recalculation and reset behavior are covered through their public methods.
  const ticketCountSites: [name: string, text: string][] = [
    ...TRIGGERS.filter((t) =>
      t.name.startsWith("trg_listing_attendees_aggregates_"),
    ).map((t): [string, string] => [t.name, t.sql.sql]),
    ["backfillListingAggregates", BACKFILL_LISTING_AGGREGATES_SQL.sql],
    ["attendeeListingContributions", attendeeListingContributionsSql(1).sql],
  ];

  for (const [name, text] of ticketCountSites) {
    test(`${name} references the shared quantity predicate`, () => {
      assertStringIncludes(text, TICKET_COUNTS_PREDICATE.sql);
    });
  }
});

/**
 * The listings count columns (booked_quantity, tickets_count) are maintained by
 * triggers on listing_attendees. These tests drive the triggers directly with
 * raw INSERT/UPDATE/DELETE so the trigger SQL itself is the unit under test —
 * including the branches the higher-level booking flows don't hit: moving a row
 * between listings, and leaving the columns untouched when an unrelated column
 * changes.
 *
 * Income is no longer a trigger-maintained column: it is projected from the
 * transfers ledger (gross credits to revenue:<listingId>) at read time, so it is
 * exercised separately via posted ledger legs rather than via price_paid.
 */
describeWithEnv(
  "db > listings aggregate triggers",
  {
    db: true,
    triggers: true,
  },
  () => {
    const incomeOf = async (listingId: number): Promise<number> => {
      invalidateListingsCache();
      return (await getListingWithCount(listingId))!.income;
    };
    const shared = sharedAggregateTriggerCases({
      counts: (quantity, rows) => ({
        booked_quantity: quantity,
        tickets_count: rows,
      }),
      insert: "insert increments quantity and ticket count",
      parent: "listing",
      // checked_in is not in the trigger's UPDATE OF list.
      unrelatedColumn: "checked_in",
    });

    test("listingsTable read exposes the trigger-maintained counts", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await seedAggregateRows(ATTENDEE_ROWS, listing.id, [[1, 3]]);
      invalidateListingsCache();
      const reread = await getListingWithCount(listing.id);
      expect(reread).toMatchObject({
        attendee_count: 3,
        tickets_count: 1,
      });
    });

    describeAggregateTriggerCases(
      {
        createParent: () => createTestListing({ maxAttendees: 50 }),
        readCounts: aggregates,
        rows: ATTENDEE_ROWS,
      },
      [
        shared.zeroStart,
        shared.insert,
        QUANTITY_ZERO_INSERT,
        ZERO_TOGGLE,
        QUANTITY_ZERO_DELETE,
        shared.delete,
        shared.updateQuantity,
        shared.moveToOtherParent,
        shared.unrelatedColumn,
      ],
    );

    test("a quantity-0 line shows no recalculation drift", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await seedAggregateRows(ATTENDEE_ROWS, listing.id, [
        [1, 3],
        [2, 0],
      ]);

      // Raw INSERTs bypass the wrapped client's cache invalidation, so refresh
      // the cache before reading the stored (current) aggregates.
      invalidateListingsCache();
      const stored = (await getListingWithCount(listing.id))!;
      const recalc = await getListingAggregateRecalculation(stored);
      // Trigger-maintained values and a from-scratch recompute must agree, so
      // the repair page never reports a ghost line as drift.
      expect(recalc.tickets_count).toEqual({ current: 1, recalculated: 1 });
      expect(recalc.booked_quantity).toEqual({ current: 3, recalculated: 3 });

      await listingAggregates.reset(listing.id, [
        "bookedQuantity",
        "ticketsCount",
      ]);
      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 3,
        tickets_count: 1,
      });
    });

    test("income is projected from the ledger's gross revenue credits", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      // A raw attendee row with no ledger legs contributes nothing to income.
      await seedAggregateRows(ATTENDEE_ROWS, listing.id, [[1, 1]]);
      expect(await incomeOf(listing.id)).toBe(0);

      // A posted booking credits revenue:<listingId>, which the income subquery
      // sums — equalling the old SUM(price_paid) for the same paid booking.
      await postListingSale({
        attendeeId: 1,
        gross: 1500,
        listingId: listing.id,
      });
      expect(await incomeOf(listing.id)).toBe(1500);
    });

    test("a refund does not reduce a listing's gross income", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await postListingSale({
        attendeeId: 7,
        gross: 4000,
        listingId: listing.id,
      });
      expect(await incomeOf(listing.id)).toBe(4000);

      // The refund reversal posts a SOURCE-side leg on revenue:<listingId>, so the
      // gross dest-credits the income reads are unchanged (it tracks gross, not net,
      // matching what admins currently see).
      await refundPostedSale(listing.id, 7);
      expect(await incomeOf(listing.id)).toBe(4000);
    });

    test("raising income via the correction path moves the projection up by the delta", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await postListingSale({
        attendeeId: 1,
        gross: 1500,
        listingId: listing.id,
      });
      expect(await incomeOf(listing.id)).toBe(1500);

      // Correcting income up to 2000 posts a writeoff→revenue credit for the
      // £5 difference (recomputed from the live 1500 projection), counted in the
      // gross-credits sum, so income rises by it.
      await adjustListingIncome(listing.id, 2000);
      expect(await incomeOf(listing.id)).toBe(2000);
    });

    test("lowering income via the correction path moves the projection down by the delta", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await postListingSale({
        attendeeId: 1,
        gross: 4000,
        listingId: listing.id,
      });
      expect(await incomeOf(listing.id)).toBe(4000);

      // Correcting income down to 2500 posts a revenue→writeoff debit for the
      // £15 difference, which the income subquery subtracts, so income falls.
      await adjustListingIncome(listing.id, 2500);
      expect(await incomeOf(listing.id)).toBe(2500);
    });

    test("a revenue→writeoff correction lowers income but a refund does not", async () => {
      // The income refinement's crux: a manual write-off debit reduces income,
      // while an ordinary refund (revenue→attendee) leaves the gross figure put.
      const listing = await createTestListing({ maxAttendees: 50 });
      await postListingSale({
        attendeeId: 7,
        gross: 5000,
        listingId: listing.id,
      });
      expect(await incomeOf(listing.id)).toBe(5000);

      // A refund of the booking does NOT reduce income (gross, not net).
      await refundPostedSale(listing.id, 7);
      expect(await incomeOf(listing.id)).toBe(5000);

      // A manual write-off correction of £20 DOES reduce it.
      await adjustListingIncome(listing.id, 3000);
      expect(await incomeOf(listing.id)).toBe(3000);
    });

    test("an income correction of zero delta posts nothing and leaves income put", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await postListingSale({
        attendeeId: 1,
        gross: 1500,
        listingId: listing.id,
      });
      const before = (await allTransfers()).length;

      await adjustListingIncome(listing.id, 1500);

      expect((await allTransfers()).length).toBe(before);
      expect(await incomeOf(listing.id)).toBe(1500);
    });

    test("manual aggregate edits override the trigger-maintained values", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await seedAggregateRows(ATTENDEE_ROWS, listing.id, [[1, 3]]);

      await listingAggregates.update(listing.id, {
        bookedQuantity: 8,
        ticketsCount: 4,
      });

      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 8,
        tickets_count: 4,
      });
    });

    test("selected aggregate reset fields are rebuilt from attendee rows", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await seedAggregateRows(ATTENDEE_ROWS, listing.id, [
        [1, 3],
        [2, 2],
      ]);
      await listingAggregates.update(listing.id, {
        bookedQuantity: 8,
        ticketsCount: 4,
      });

      const stale = (await getListingWithCount(listing.id))!;
      expect(await getListingAggregateRecalculation(stale)).toEqual({
        booked_quantity: { current: 8, recalculated: 5 },
        tickets_count: { current: 4, recalculated: 2 },
      });

      await listingAggregates.reset(listing.id, ["bookedQuantity"]);

      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 5,
        tickets_count: 4,
      });
    });

    test("the migration's backfill recomputes stale aggregates from scratch", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await seedAggregateRows(ATTENDEE_ROWS, listing.id, [
        [1, 3],
        [2, 2],
      ]);

      // Reproduce a pre-trigger state: drop the triggers, then corrupt the
      // columns directly (no trigger fires to correct them).
      const migration = MIGRATIONS.find(
        (m) => m.id === "2026-06-16_listing_aggregates",
      )!;
      await getDb().batch(
        [
          sql`DROP TRIGGER IF EXISTS trg_listing_attendees_aggregates_insert`,
          sql`DROP TRIGGER IF EXISTS trg_listing_attendees_aggregates_delete`,
          sql`DROP TRIGGER IF EXISTS trg_listing_attendees_aggregates_update`,
        ],
        "write",
      );
      await getDb().execute(
        sql`UPDATE listings SET booked_quantity = 999, tickets_count = 999`,
      );

      // Re-running up() recreates the triggers and recomputes the absolute totals.
      await migration.up();

      expect(await aggregates(listing.id)).toEqual({
        booked_quantity: 5,
        tickets_count: 2,
      });
    });
  },
);

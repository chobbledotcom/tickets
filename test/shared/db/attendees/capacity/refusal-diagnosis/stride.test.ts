// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { LineBooking } from "#db/attendee-types.ts";
import { refusedOrderUnfitListingIds } from "#db/attendees/capacity/refusal-diagnosis.ts";
import { execute } from "#db/client.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#db/query-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";
import { awaitObservedProbe, line } from "./helpers.ts";

// jscpd:ignore-end

/** The stride-batch tests for a refused order too long for one probe batch:
 * the bracket narrows over a bounded sample of prefixes, and every batch
 * re-proves the bracket ends it carries. */
describeWithEnv("db > refusedOrderUnfitListingIds", { db: true }, () => {
  /** Seventeen roomy lines whose shared group has one place: only the first
   * fits, so the bracket must narrow to the second line. */
  const seventeenLinesSharingOnePlace = async (): Promise<LineBooking[]> => {
    const shared = await createTestGroup({ maxAttendees: 1 });
    const lines: LineBooking[] = [];
    for (let index = 0; index < 17; index++) {
      const listing = await createTestListing({
        groupId: shared.id,
        maxAttendees: 10,
      });
      lines.push(line(listing.id));
    }
    return lines;
  };

  test("a longer refused order narrows a bracket instead of one query per line", async () => {
    // Seventeen lines share one place. The first stride batch samples every
    // third prefix plus the bracket end, the second asks the bracket's own
    // lines: three round trips total, not one probe statement per prefix.
    const lines = await seventeenLinesSharingOnePlace();
    let diagnosis: number[] | undefined;
    expect(
      await countDatabaseCalls(4, async () => {
        diagnosis = await refusedOrderUnfitListingIds(lines);
      }),
    ).toBe(3);
    expect(diagnosis).toEqual([lines[1]!.listingId]);
  });

  test("every probe batch holds at most the stride sample plus its bracket ends", async () => {
    // One query per prefix makes the diagnostic request grow with the square
    // of the order's length, past the platform's payload limits. Every batch
    // must stay bounded at the stride sample however many lines there are —
    // the facts batch, then batches sharing one round-trip window each.
    const lines = await seventeenLinesSharingOnePlace();
    await runWithQueryLogContext(async () => {
      enableQueryLog();
      await refusedOrderUnfitListingIds(lines);
      const probeBatches = Map.groupBy(
        getQueryLog().filter((entry) => entry.sql.includes("AS fits")),
        (entry) => entry.startedAtMs,
      );
      expect(probeBatches.size).toBeGreaterThanOrEqual(2);
      for (const probes of probeBatches.values()) {
        expect(probes.length).toBeLessThanOrEqual(10);
      }
    });
  });

  test("a long order names the tipping line from stride samples alone", async () => {
    // Sixty-five alternating lines is too many for one probe batch: the
    // samples bracket the first unfit prefix (21), then narrow it over two
    // more batches — four round trips, and the twenty-first line (an `a`
    // line) is named without any batch asking one probe per line.
    const { a, b } = await twentyPlaceGroupMembers();
    const lines = Array.from({ length: 65 }, (_unused, index) =>
      line(index % 2 ? b.id : a.id),
    );

    let diagnosis: number[] | undefined;
    expect(
      await countDatabaseCalls(4, async () => {
        diagnosis = await refusedOrderUnfitListingIds(lines);
      }),
    ).toBe(4);
    expect(diagnosis).toEqual([a.id]);
  });

  test("a booking that consumes room between batches still names the first unfit line", async () => {
    // Each probe batch is its own snapshot. The bracket's fitting side
    // carries between batches for sampling, so a booking that consumed the
    // room after the first batch can leave an earlier line the first that
    // no longer fits — every batch must re-prove the carried bound before
    // trusting it, rather than meter its samples from a bound that booking
    // outran and name a later line. Twelve of the twenty places go, so the
    // ninth line becomes the first that does not fit, and the reset the
    // failed re-prove triggers is one billed batch: the whole interleave
    // costs exactly this many round trips.
    const { a, b } = await twentyPlaceGroupMembers();
    const lines = [line(a.id)] as LineBooking[];
    for (let index = 1; index < 65; index++) {
      lines.push(line(b.id));
    }

    let diagnosis: number[] | undefined;
    expect(
      await countDatabaseCalls(12, async () => {
        await runWithQueryLogContext(async () => {
          enableQueryLog();
          const diagnosing = refusedOrderUnfitListingIds(lines);
          // The first batch's log entries appear once it lands, so waiting
          // for the fits SQL to be observed means the carried bound the
          // next batch samples from is already fixed — a limit expiry must
          // fail the test, not land the consuming booking after the whole
          // diagnosis and pass vacuously.
          await awaitObservedProbe();
          // Consume twelve of the group's places after that batch: the
          // ninth line is now the first that does not fit, whatever the
          // earlier snapshots said.
          await execute(
            "INSERT INTO listing_attendees " +
              "(listing_id, attendee_id, start_at, end_at, quantity, order_token, parent_listing_id, package_group_id) " +
              "VALUES (?, ?, NULL, NULL, ?, ?, 0, 0)",
            [a.id, 999_999, 12, ""],
          );
          diagnosis = await diagnosing;
        });
      }),
    ).toBe(6);
    expect(diagnosis).toEqual([b.id]);
  });

  test("an order whose first line alone busts a zero-cap listing names it", async () => {
    // A zero-cap listing makes every prefix that includes its line unfit,
    // including the first probe of the first batch — the bracket must fall
    // back to the very first line, not treat the probe before it as
    // fitting.
    const a = await createTestListing({ maxAttendees: 0 });
    const b = await createTestListing({ maxAttendees: 10 });
    const lines = [line(a.id)] as LineBooking[];
    for (let index = 1; index < 10; index++) {
      lines.push(line(b.id));
    }

    expect(await refusedOrderUnfitListingIds(lines)).toEqual([a.id]);
  });
});

/** A twenty-place group with two roomy members, so only the group cap
 * binds an order, for orders long enough to need stride batches. */
const twentyPlaceGroupMembers = async (): Promise<{
  a: { id: number };
  b: { id: number };
}> => {
  const shared = await createTestGroup({ maxAttendees: 20 });
  const a = await createTestListing({
    groupId: shared.id,
    maxAttendees: 64,
  });
  const b = await createTestListing({
    groupId: shared.id,
    maxAttendees: 64,
  });
  return { a, b };
};

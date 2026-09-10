// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { LineBooking } from "#db/attendee-types.ts";
import { refusedOrderUnfitListingIds } from "#db/attendees/capacity/refusal-diagnosis.ts";
import { execute, getDb } from "#db/client.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#db/query-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestGroup,
  createTwoListingsSharingOnePlace,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";
import { line } from "./helpers.ts";

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
    const { a, b, lines } = await longOrderOnGroup(65);

    // The twelve places go once the first probe batch resolves and before
    // the diagnosis sees its result.
    using _batchGate = gateDiagnosisBatches(async (call) => {
      if (call === 2) {
        await execute(
          "INSERT INTO listing_attendees " +
            "(listing_id, attendee_id, start_at, end_at, quantity, order_token, parent_listing_id, package_group_id) " +
            "VALUES (?, ?, NULL, NULL, ?, ?, 0, 0)",
          [a.id, 999_999, 12, ""],
        );
      }
    });

    let diagnosis: number[] | undefined;
    expect(
      await countDatabaseCalls(8, async () => {
        diagnosis = await refusedOrderUnfitListingIds(lines);
      }),
    ).toBe(6);
    expect(diagnosis).toEqual([b.id]);
  });

  test("a room that moves under every batch names nothing once its batch budget spends", async () => {
    // Twelve places held on odd probe batches, nineteen on even ones: each
    // batch meets a room the batch before it misdescribed, so no batch can
    // prove an adjacent prefix pair and the whole order never fits either.
    // The fixed batch budget runs out and names no line, and the whole ask
    // stays bounded — the facts batch, the probe batches, and one occupancy
    // flip between batches. The budget itself is eight batches (the form
    // cap of 1,000 lines narrowed by the stride of 8, plus headroom).
    const { a, lines } = await longOrderOnGroup(65);

    let churnPlaces = 0;
    const holdPlaces = async (places: number): Promise<void> => {
      if (churnPlaces === 0) {
        await execute(
          "INSERT INTO listing_attendees " +
            "(listing_id, attendee_id, start_at, end_at, quantity, order_token, parent_listing_id, package_group_id) " +
            "VALUES (?, ?, NULL, NULL, ?, '', 0, 0)",
          [a.id, 999_998, places],
        );
      } else {
        await execute(
          "UPDATE listing_attendees SET quantity = ? WHERE attendee_id = ?",
          [places, 999_998],
        );
      }
      churnPlaces = places;
    };

    using _batchGate = gateDiagnosisBatches(async (call) => {
      if (call <= 8) {
        await holdPlaces(call % 2 ? 12 : 19);
      }
    });

    let diagnosis: number[] | undefined;
    expect(
      await countDatabaseCalls(17, async () => {
        diagnosis = await refusedOrderUnfitListingIds(lines);
      }),
    ).toBe(17);
    expect(diagnosis).toEqual([]);
  });

  test("a member that joins a new full group mid-diagnosis still names the first unfit line", async () => {
    // The probes' demands carry each line's group memberships, so a
    // membership change between batches can turn the whole answer stale —
    // without the per-batch facts re-read, the search would metre from a
    // model that misses the new cap and name a far later line. A spare
    // one-place group joins the order's two listings once the first probe
    // batch resolves; the next batch re-validates its facts inside its own
    // snapshot, voids the stale-sided one, and names the second line.
    const { a, b, lines } = await longOrderOnGroup(65);
    const spare = await createTestGroup({
      maxAttendees: 1,
      name: "Spare full group",
    });
    // The group-create helper returns the last cached row, which is
    // ambiguous once two groups exist; take the spare by its own name.
    const { groups } = await import("#db/groups.ts");
    const fullGroup = (await groups.cache.getAll()).find(
      (group) => group.id === spare.id,
    )!;

    using _batchGate = gateDiagnosisBatches(async (call) => {
      // The membership lands after the facts batch and before the first
      // probe batch, so that batch's own fact re-read sees it and voids the
      // stale-sided fits.
      if (call === 1) {
        await execute(
          "INSERT INTO group_listings (group_id, listing_id) " +
            "VALUES (?, ?), (?, ?)",
          [fullGroup.id, a.id, fullGroup.id, b.id],
        );
      }
    });

    let diagnosis: number[] | undefined;
    expect(
      await countDatabaseCalls(6, async () => {
        diagnosis = await refusedOrderUnfitListingIds(lines);
      }),
    ).toBe(6);
    expect(diagnosis).toEqual([b.id]);
  });

  test("a listing that vanishes mid-diagnosis names nothing", async () => {
    // The re-read fact rows beside each batch also answer for an order
    // listing another isolate deleted while the diagnosis ran: the probes
    // cannot demand from a listing without facts, so the answer is no
    // culprit rather than a partial guess.
    const { first, second } = await createTwoListingsSharingOnePlace();

    using _batchGate = gateDiagnosisBatches(async (call) => {
      // The delete lands after the facts batch and before the first probe
      // batch, so that batch's own fact re-read answers for the vanished
      // listing.
      if (call === 1) {
        await execute("DELETE FROM listings WHERE id = ?", [second.id]);
      }
    });

    let diagnosis: number[] | undefined;
    expect(
      await countDatabaseCalls(3, async () => {
        diagnosis = await refusedOrderUnfitListingIds([
          line(first.id),
          line(second.id),
        ]);
      }),
    ).toBe(3);
    expect(diagnosis).toEqual([]);
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
 * binds an order. */
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

/** A long order on the twenty-place group — one a-line, then b-lines — long
 * enough that only the group cap binds and the probe batches explore it. */
const longOrderOnGroup = async (
  lineCount: number,
): Promise<{
  a: { id: number };
  b: { id: number };
  lines: LineBooking[];
}> => {
  const { a, b } = await twentyPlaceGroupMembers();
  const lines = [line(a.id)] as LineBooking[];
  for (let index = 1; index < lineCount; index++) {
    lines.push(line(b.id));
  }
  return { a, b, lines };
};

/** Stub the guarded client's batch calls and run `betweenBatches` after each
 * one, so a mid-diagnosis room change lands between batches deterministically.
 * Call 1 is the facts batch; every later call is one probe batch. */
const gateDiagnosisBatches = (
  betweenBatches: (call: number) => Promise<void>,
) => {
  const client = getDb();
  const realBatch = client.batch.bind(client);
  let calls = 0;
  return stub(
    client,
    "batch",
    async (
      statements: Parameters<typeof realBatch>[0],
      mode?: Parameters<typeof realBatch>[1],
    ) => {
      const results = await realBatch(statements, mode);
      calls++;
      await betweenBatches(calls);
      return results;
    },
  );
};

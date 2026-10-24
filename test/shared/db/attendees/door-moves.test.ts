import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { moveTicketsAndLog, ticketsWord } from "#db/attendees/door-moves.ts";
import {
  deliveredScanOperation,
  scanOperationGuard,
} from "#db/processed-scan-operations.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { storedCheckinRows } from "#test-utils/db-helpers/checkin-rows.ts";

describe("ticketsWord", () => {
  test("words one ticket and many tickets the way the log says them", () => {
    expect(ticketsWord(1)).toBe("1 ticket");
    expect(ticketsWord(3)).toBe("3 tickets");
    expect(ticketsWord(0)).toBe("0 tickets");
  });
});

describeWithEnv("moveTicketsAndLog", { db: true }, () => {
  test("moves the tickets and logs each move that moved some", async () => {
    const { attendee, listing } = await createTestAttendeeWithToken(
      "Hal",
      "hal@x.com",
      { name: "Doors" },
      3,
    );
    const move = { attendeeId: attendee.id, count: 2, listingId: listing.id };

    const moved = await moveTicketsAndLog(
      "admit",
      [move],
      (answer) => `moved ${answer.count} for ${answer.attendeeId}`,
    );

    expect(moved).toEqual([{ ...move, owedAfter: 1 }]);
    expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 2 }]);
    assertArrayIncludes(await activityMessages(), [
      `moved 2 for ${attendee.id}`,
    ]);

    // A move of a single ticket is still a move, and still logged.
    await moveTicketsAndLog(
      "admit",
      [{ ...move, count: 1 }],
      (answer) => `moved ${answer.count} for ${answer.attendeeId}`,
    );
    assertArrayIncludes(await activityMessages(), [
      `moved 1 for ${attendee.id}`,
    ]);
  });

  test("writes no activity row for a move that moved nothing", async () => {
    const { attendee, listing } = await createTestAttendeeWithToken(
      "Ivy",
      "ivy@x.com",
      { name: "Doors" },
    );
    const before = (await activityMessages()).length;

    // Nothing is admitted yet, so a release has nothing to move.
    const moved = await moveTicketsAndLog(
      "release",
      [{ attendeeId: attendee.id, count: 1, listingId: listing.id }],
      () => "should not be written",
    );

    expect(moved[0]!.count).toBe(0);
    expect((await activityMessages()).length).toBe(before);
  });

  test("a guard that reserves admits inside the same write", async () => {
    const { attendee, listing } = await createTestAttendeeWithToken(
      "Lena",
      "lena@x.com",
      { name: "Doors" },
      3,
    );
    const move = { attendeeId: attendee.id, count: 1, listingId: listing.id };

    const moved = await moveTicketsAndLog(
      "admit",
      [move],
      (answer) => `moved ${answer.count} for ${answer.attendeeId}`,
      { reserve: async () => true },
    );

    expect(moved).toEqual([{ ...move, owedAfter: 2 }]);
    expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 1 }]);
  });

  test("a guard that reserves nothing moves nothing and writes no row", async () => {
    // A queued delivery that lost its first answer replays with the id it
    // made up. The reserve answers false, so the replay moves nothing, and
    // one delivery never admits a second ticket.
    const { attendee, listing } = await createTestAttendeeWithToken(
      "Milo",
      "milo@x.com",
      { name: "Doors" },
      2,
    );
    const before = (await activityMessages()).length;

    const moved = await moveTicketsAndLog(
      "admit",
      [{ attendeeId: attendee.id, count: 1, listingId: listing.id }],
      () => "should not be written",
      { reserve: async () => false },
    );

    expect(moved).toEqual([]);
    expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 0 }]);
    expect((await activityMessages()).length).toBe(before);
  });

  test("a failed settle rolls the move back with it", async () => {
    // The settle corrects the delivery's stored admission inside the write
    // that moved the tickets. A failure in either write rolls both back, so
    // the ledger never records an admission the write undid.
    const { attendee, listing } = await createTestAttendeeWithToken(
      "Nora",
      "nora@x.com",
      { name: "Doors" },
      2,
    );

    await expect(
      moveTicketsAndLog(
        "admit",
        [{ attendeeId: attendee.id, count: 1, listingId: listing.id }],
        (answer) => `moved ${answer.count} for ${answer.attendeeId}`,
        {
          reserve: async () => true,
          settle: async () => {
            throw new Error("settle failed");
          },
        },
      ),
    ).rejects.toThrow("settle failed");
    expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 0 }]);
  });

  test("a door race settles the delivery's record to what the write really moved", async () => {
    // Another door checked one of the party's two remaining places in
    // between the delivery's decision and its write. The write then moves
    // one place where the delivery claimed two, and the stored admission
    // reads that one — a resend answers what really happened, never the
    // delivery's own pick.
    const { attendee, listing } = await createTestAttendeeWithToken(
      "Otto",
      "otto@x.com",
      { name: "Doors" },
      2,
    );
    await moveTicketsAndLog(
      "admit",
      [{ attendeeId: attendee.id, count: 1, listingId: listing.id }],
      () => "the other door's move",
    );

    const moved = await moveTicketsAndLog(
      "admit",
      [{ attendeeId: attendee.id, count: 2, listingId: listing.id }],
      (answer) => `moved ${answer.count} for ${answer.attendeeId}`,
      scanOperationGuard({
        listingIds: [listing.id],
        operationId: "op-door-race-1",
        quantity: 2,
        tokenHash: "digest-door-race-1",
      }),
    );

    expect(moved).toEqual([
      {
        attendeeId: attendee.id,
        count: 1,
        listingId: listing.id,
        owedAfter: 0,
      },
    ]);
    expect(
      await deliveredScanOperation("op-door-race-1", "digest-door-race-1"),
    ).toEqual({ listingIds: [listing.id], quantity: 1 });
    expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 2 }]);
  });
});

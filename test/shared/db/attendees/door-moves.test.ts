import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { moveTicketsAndLog, ticketsWord } from "#db/attendees/door-moves.ts";
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
    expect(await activityMessages()).toContain(`moved 2 for ${attendee.id}`);

    // A move of a single ticket is still a move, and still logged.
    await moveTicketsAndLog(
      "admit",
      [{ ...move, count: 1 }],
      (answer) => `moved ${answer.count} for ${answer.attendeeId}`,
    );
    expect(await activityMessages()).toContain(`moved 1 for ${attendee.id}`);
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
});

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDateAttendeeCount } from "#lib/db/attendees.ts";
import { bookAttendee, createTestEvent, describeWithEnv } from "#test-utils";

describeWithEnv("db > attendees > getDateAttendeeCount", { db: true }, () => {
  const dailyOpts = {
    bookableDays: [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ],
    eventType: "daily" as const,
    maximumDaysAfter: 14,
    minimumDaysBefore: 0,
  };

  test("returns 0 when no attendees for date", async () => {
    const event = await createTestEvent({
      maxAttendees: 10,
      ...dailyOpts,
    });
    const count = await getDateAttendeeCount(event.id, "2026-02-10");
    expect(count).toBe(0);
  });

  test("returns correct count for date with attendees", async () => {
    const event = await createTestEvent({
      maxAttendees: 10,
      ...dailyOpts,
    });

    await bookAttendee(event, {
      date: "2026-02-10",
      email: "u1@example.com",
      name: "User 1",
      quantity: 2,
    });
    await bookAttendee(event, {
      date: "2026-02-10",
      email: "u2@example.com",
      name: "User 2",
      quantity: 3,
    });

    const count = await getDateAttendeeCount(event.id, "2026-02-10");
    expect(count).toBe(5);
  });

  test("does not count attendees on different dates", async () => {
    const event = await createTestEvent({
      maxAttendees: 10,
      ...dailyOpts,
    });

    await bookAttendee(event, {
      date: "2026-02-10",
      email: "u1@example.com",
      name: "User 1",
      quantity: 2,
    });
    await bookAttendee(event, {
      date: "2026-02-11",
      email: "u2@example.com",
      name: "User 2",
      quantity: 1,
    });

    expect(await getDateAttendeeCount(event.id, "2026-02-10")).toBe(2);
    expect(await getDateAttendeeCount(event.id, "2026-02-11")).toBe(1);
  });
});

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createAttendeeAtomic,
  getDateAttendeeCount,
} from "#lib/db/attendees.ts";
import { createDailyTestEvent, describeWithEnv } from "#test-utils";

describeWithEnv("db > attendees > getDateAttendeeCount", { db: true }, () => {
  test("returns 0 when no attendees for date", async () => {
    const event = await createDailyTestEvent();
    const count = await getDateAttendeeCount(event.id, "2026-02-10");
    expect(count).toBe(0);
  });

  test("returns correct count for date with attendees", async () => {
    const event = await createDailyTestEvent();

    await createAttendeeAtomic({
      bookings: [{ date: "2026-02-10", eventId: event.id, quantity: 2 }],
      email: "u1@example.com",
      name: "User 1",
    });
    await createAttendeeAtomic({
      bookings: [{ date: "2026-02-10", eventId: event.id, quantity: 3 }],
      email: "u2@example.com",
      name: "User 2",
    });

    const count = await getDateAttendeeCount(event.id, "2026-02-10");
    expect(count).toBe(5);
  });

  test("does not count attendees on different dates", async () => {
    const event = await createDailyTestEvent();

    await createAttendeeAtomic({
      bookings: [{ date: "2026-02-10", eventId: event.id, quantity: 2 }],
      email: "u1@example.com",
      name: "User 1",
    });
    await createAttendeeAtomic({
      bookings: [{ date: "2026-02-11", eventId: event.id, quantity: 1 }],
      email: "u2@example.com",
      name: "User 2",
    });

    expect(await getDateAttendeeCount(event.id, "2026-02-10")).toBe(2);
    expect(await getDateAttendeeCount(event.id, "2026-02-11")).toBe(1);
  });
});

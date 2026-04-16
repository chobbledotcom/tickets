import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  addEventLink,
  createAttendeeAtomic,
  getAttendeesRaw,
} from "#lib/db/attendees.ts";
import {
  createDailyTestEvent,
  createTestEvent,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("db > attendees > addEventLink", { db: true }, () => {
  test("admits a multi-day link whose range contains non-overlapping bookings", async () => {
    // Per-day expansion must admit a range whose days each have room,
    // even though overlap-sum sees multiple bookings inside the window.
    const event = await createDailyTestEvent({
      durationDays: 3,
      maxAttendees: 2,
      maximumDaysAfter: 30,
    });
    for (const [date, email] of [
      ["2026-05-01", "a@example.com"],
      ["2026-05-03", "b@example.com"],
    ] as const) {
      await createAttendeeAtomic({
        bookings: [{ date, durationDays: 1, eventId: event.id, quantity: 1 }],
        email,
        name: email,
      });
    }
    const base = await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-20", durationDays: 1, eventId: event.id, quantity: 1 },
      ],
      email: "base@example.com",
      name: "Base",
    });
    if (!base.success) throw new Error("setup failed");
    const link = await addEventLink(base.attendees[0]!.id, {
      date: "2026-05-01",
      durationDays: 3,
      eventId: event.id,
      quantity: 1,
    });
    expect(link.success).toBe(true);
  });

  test("defaults quantity to 1 when omitted", async () => {
    const first = await createTestEvent({ maxAttendees: 3 });
    const second = await createTestEvent({ maxAttendees: 3 });
    const base = await createAttendeeAtomic({
      bookings: [{ eventId: first.id, quantity: 1 }],
      email: "qdef@example.com",
      name: "QDef",
    });
    if (!base.success) throw new Error("setup failed");
    const link = await addEventLink(base.attendees[0]!.id, {
      eventId: second.id,
    });
    expect(link.success).toBe(true);
    const rows = await getAttendeesRaw(second.id);
    expect(Number(rows[0]!.quantity)).toBe(1);
  });
});

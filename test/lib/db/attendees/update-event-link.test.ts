import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createAttendeeAtomic,
  getAttendeesRaw,
} from "#lib/db/attendees.ts";
import {
  createDailyTestEvent,
  createTestEvent,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("db > attendees > updateEventLink", { db: true }, () => {
  test("updates quantity with capacity guard", async () => {
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const event = await createTestEvent({ maxAttendees: 5 });
    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event.id, quantity: 2 }],
      email: "link@test.com",
      name: "Link",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const update = await updateEventLink(result.attendees[0]!.id, event.id, {
      date: null,
      quantity: 3,
    });
    expect(update.success).toBe(true);

    const raw = await getAttendeesRaw(event.id);
    expect(raw[0]!.quantity).toBe(3);
  });

  test("rejects update that would exceed capacity", async () => {
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const event = await createTestEvent({ maxAttendees: 3 });
    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event.id, quantity: 2 }],
      email: "cap@test.com",
      name: "Cap",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const update = await updateEventLink(result.attendees[0]!.id, event.id, {
      date: null,
      quantity: 4,
    });
    expect(update.success).toBe(false);
  });

  test("updates date for daily event link", async () => {
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const event = await createDailyTestEvent();
    const result = await createAttendeeAtomic({
      bookings: [{ date: "2026-04-07", eventId: event.id }],
      email: "daily@test.com",
      name: "Daily",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const update = await updateEventLink(result.attendees[0]!.id, event.id, {
      date: "2026-04-08",
      quantity: 1,
    });
    expect(update.success).toBe(true);

    const raw = await getAttendeesRaw(event.id);
    expect(raw[0]!.date).toBe("2026-04-08");
  });
});

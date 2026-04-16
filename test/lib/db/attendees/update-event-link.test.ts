import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createAttendeeAtomic,
  getAttendeesRaw,
} from "#lib/db/attendees.ts";
import {
  createDailyTestEvent,
  createTestEvent,
  createTestGroup,
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
    const event = await createTestEvent({
      eventType: "daily",
      maxAttendees: 10,
    });
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

  test("admits a multi-day update whose range contains non-overlapping bookings", async () => {
    // Overlap-sum would over-reject (it sees 2 in the window); per-day
    // expansion lets the update through because no day exceeds cap.
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const event = await createDailyTestEvent({
      durationDays: 3,
      maxAttendees: 2,
      maximumDaysAfter: 30,
    });
    for (const [date, email] of [
      ["2026-06-01", "x@example.com"],
      ["2026-06-03", "y@example.com"],
    ] as const) {
      await createAttendeeAtomic({
        bookings: [{ date, durationDays: 1, eventId: event.id, quantity: 1 }],
        email,
        name: email,
      });
    }
    const target = await createAttendeeAtomic({
      bookings: [
        { date: "2026-06-20", durationDays: 1, eventId: event.id, quantity: 1 },
      ],
      email: "t@example.com",
      name: "T",
    });
    if (!target.success) throw new Error("setup failed");
    const moved = await updateEventLink(target.attendees[0]!.id, event.id, {
      date: "2026-06-01",
      durationDays: 3,
      quantity: 1,
    });
    expect(moved.success).toBe(true);
  });

  test("returns capacity_exceeded when the (attendee, event) pair has no row", async () => {
    // Preflight passes but the UPDATE's base predicate matches no row, so
    // rowsAffected = 0. Covers the atomic-rejection safety net.
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const event = await createTestEvent({ maxAttendees: 5 });
    const result = await updateEventLink(999_999, event.id, {
      date: null,
      quantity: 1,
    });
    expect(result.success).toBe(false);
  });

  test("self-excludes the row being edited on a group-capped daily event", async () => {
    // Moving a booking to a new day must not see its own row in the
    // group-day count, otherwise a full-capacity booking can never move.
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const group = await createTestGroup({ maxAttendees: 2 });
    const event = await createDailyTestEvent({
      groupId: group.id,
      maxAttendees: 5,
      maximumDaysAfter: 30,
    });
    const own = await createAttendeeAtomic({
      bookings: [
        { date: "2026-07-01", durationDays: 1, eventId: event.id, quantity: 2 },
      ],
      email: "own@example.com",
      name: "Own",
    });
    if (!own.success) throw new Error("setup failed");
    const moved = await updateEventLink(own.attendees[0]!.id, event.id, {
      date: "2026-07-02",
      durationDays: 1,
      quantity: 2,
    });
    expect(moved.success).toBe(true);
  });

  test("self-excludes the row being edited on a group-capped standard event", async () => {
    // Standard-event path of getGroupAttendeeCount (date = null branch).
    const { updateEventLink } = await import("#lib/db/attendees.ts");
    const group = await createTestGroup({ maxAttendees: 3 });
    const event = await createTestEvent({
      eventType: "standard",
      groupId: group.id,
      maxAttendees: 10,
    });
    const own = await createAttendeeAtomic({
      bookings: [{ eventId: event.id, quantity: 2 }],
      email: "sg@example.com",
      name: "Own",
    });
    if (!own.success) throw new Error("setup failed");
    const resized = await updateEventLink(own.attendees[0]!.id, event.id, {
      date: null,
      quantity: 3,
    });
    expect(resized.success).toBe(true);
  });
});

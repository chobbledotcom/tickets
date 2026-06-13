import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createAttendeeAtomic,
  decryptAttendees,
  getAttendeesRaw,
} from "#shared/db/attendees.ts";
import { dateToRange } from "#shared/db/capacity.ts";
import { getDb } from "#shared/db/client.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import {
  createDailyTestEvent,
  createTestEvent,
  createTestGroup,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

/** Fetch raw start_at/end_at for an event (getAttendeesRaw drops them). */
const getRange = async (
  eventId: number,
): Promise<{ start_at: string; end_at: string }> => {
  const res = await getDb().execute({
    args: [eventId],
    sql: "SELECT start_at, end_at FROM event_attendees WHERE event_id = ?",
  });
  return res.rows[0] as unknown as { start_at: string; end_at: string };
};

describeWithEnv("db > attendees > createAttendeeAtomic", { db: true }, () => {
  test("succeeds when capacity available", async () => {
    const event = await createTestEvent({
      maxAttendees: 5,
      thankYouUrl: "https://example.com",
    });

    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event.id, quantity: 2 }],
      email: "john@example.com",
      name: "John",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.attendees.length).toBe(1);
      expect(result.attendees[0]!.name).toBe("John");
    }
  });

  test("links single attendee record to multiple events for group purchase", async () => {
    const event1 = await createTestEvent({ maxAttendees: 10 });
    const event2 = await createTestEvent({ maxAttendees: 10 });

    const result = await createAttendeeAtomic({
      bookings: [
        { eventId: event1.id, quantity: 2 },
        { eventId: event2.id, quantity: 3 },
      ],
      email: "multi@example.com",
      name: "Multi Buyer",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Both booking results point to the same underlying attendee row
    expect(result.attendees.length).toBe(2);
    const attendeeId = result.attendees[0]!.id;
    expect(result.attendees[1]!.id).toBe(attendeeId);

    const event1Raw = await getAttendeesRaw(event1.id);
    expect(event1Raw.length).toBe(1);
    expect(event1Raw[0]!.id).toBe(attendeeId);
    expect(event1Raw[0]!.quantity).toBe(2);

    const event2Raw = await getAttendeesRaw(event2.id);
    expect(event2Raw.length).toBe(1);
    expect(event2Raw[0]!.id).toBe(attendeeId);
    expect(event2Raw[0]!.quantity).toBe(3);
  });

  test("fails when capacity exceeded", async () => {
    const event = await createTestEvent({
      maxAttendees: 1,
      thankYouUrl: "https://example.com",
    });
    await createAttendeeAtomic({
      bookings: [{ eventId: event.id }],
      email: "first@example.com",
      name: "First",
    });

    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event.id, quantity: 1 }],
      email: "second@example.com",
      name: "Second",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("capacity_exceeded");
    }
  });

  test("fails with empty bookings", async () => {
    const result = await createAttendeeAtomic({
      bookings: [],
      email: "nobody@example.com",
      name: "Nobody",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("capacity_exceeded");
    }
  });

  test("fails when encryption key not configured", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });

    await getDb().execute({
      args: [CONFIG_KEYS.PUBLIC_KEY],
      sql: "DELETE FROM settings WHERE key = ?",
    });
    settings.invalidateCache();

    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event.id }],
      email: "john@example.com",
      name: "John",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("encryption_error");
    }
  });

  test("stores and returns price_paid when provided", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
      unitPrice: 2500,
    });

    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event.id, pricePaid: 2500, quantity: 1 }],
      email: "pay@example.com",
      name: "Paying Customer",
      paymentId: "pi_test_price",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.attendees[0]!.price_paid).toBe("2500");
    }

    const privateKey = await getTestPrivateKey();
    const raw = await getAttendeesRaw(event.id);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees[0]?.price_paid).toBe("2500");
  });

  test("stores end_at = start_at + duration days for daily multi-day bookings", async () => {
    const event = await createDailyTestEvent({
      durationDays: 3,
      maxAttendees: 5,
      maximumDaysAfter: 30,
    });
    await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-01", durationDays: 3, eventId: event.id, quantity: 1 },
      ],
      email: "range@example.com",
      name: "Range",
    });
    const { start_at, end_at } = await getRange(event.id);
    expect(start_at).toBe("2026-05-01T00:00:00Z");
    expect(end_at).toBe("2026-05-04T00:00:00.000Z");
  });

  test("year-boundary range stores end_at correctly", async () => {
    const event = await createDailyTestEvent({
      durationDays: 7,
      maxAttendees: 2,
      maximumDaysAfter: 400,
    });
    await createAttendeeAtomic({
      bookings: [
        { date: "2026-12-30", durationDays: 7, eventId: event.id, quantity: 1 },
      ],
      email: "ny@example.com",
      name: "NewYear",
    });
    const { start_at, end_at } = await getRange(event.id);
    expect(start_at).toBe("2026-12-30T00:00:00Z");
    expect(end_at).toBe("2027-01-06T00:00:00.000Z");
  });

  test("boundary: day-N end does not overlap another booking starting on day N", async () => {
    // Two 1-day bookings back-to-back at cap=1. start_at strict <, end_at
    // strict > — the second must fit.
    const event = await createDailyTestEvent({
      maxAttendees: 1,
      maximumDaysAfter: 30,
    });
    const a = await createAttendeeAtomic({
      bookings: [{ date: "2026-05-01", eventId: event.id, quantity: 1 }],
      email: "a@example.com",
      name: "A",
    });
    expect(a.success).toBe(true);
    const b = await createAttendeeAtomic({
      bookings: [{ date: "2026-05-02", eventId: event.id, quantity: 1 }],
      email: "b@example.com",
      name: "B",
    });
    expect(b.success).toBe(true);
  });

  test("atomic SQL rejects a multi-day booking spanning a full day (no preflight)", async () => {
    // Bypass checkBatchAvailability and stress the inline capacity check in
    // the INSERT: day 2 at cap, 3-day booking starting day 1 must reject.
    const event = await createDailyTestEvent({
      durationDays: 3,
      maxAttendees: 2,
      maximumDaysAfter: 30,
    });
    await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-02", durationDays: 1, eventId: event.id, quantity: 2 },
      ],
      email: "mid@example.com",
      name: "Mid",
    });
    const result = await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-01", durationDays: 3, eventId: event.id, quantity: 1 },
      ],
      email: "span@example.com",
      name: "Span",
    });
    expect(result.success).toBe(false);
  });

  test("concurrent at-capacity inserts: only one wins", async () => {
    const event = await createTestEvent({ maxAttendees: 1 });
    const [a, b] = await Promise.all([
      createAttendeeAtomic({
        bookings: [{ eventId: event.id, quantity: 1 }],
        email: "a@example.com",
        name: "A",
      }),
      createAttendeeAtomic({
        bookings: [{ eventId: event.id, quantity: 1 }],
        email: "b@example.com",
        name: "B",
      }),
    ]);
    expect([a.success, b.success].filter(Boolean).length).toBe(1);
  });

  test("rejects negative quantities (defensive guard at library boundary)", async () => {
    const event = await createTestEvent({ maxAttendees: 5 });
    const result = await createAttendeeAtomic({
      bookings: [{ eventId: event.id, quantity: -1 }],
      email: "neg@example.com",
      name: "Neg",
    });
    expect(result.success).toBe(false);
  });

  test("rejects duplicate (event, date) rows in one cart", async () => {
    // The event_attendees unique index is (event_id, attendee_id, start_at)
    // — two rows with the same tuple would violate it and silently deliver
    // a half-fulfilled booking. Reject upfront so the caller merges qty.
    const event = await createDailyTestEvent({
      maxAttendees: 10,
      maximumDaysAfter: 30,
    });
    const dup = await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-01", eventId: event.id, quantity: 1 },
        { date: "2026-05-01", eventId: event.id, quantity: 1 },
      ],
      email: "dup@example.com",
      name: "Dup",
    });
    expect(dup.success).toBe(false);
    // Different dates on the same event are fine.
    const ok = await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-01", eventId: event.id, quantity: 1 },
        { date: "2026-05-02", eventId: event.id, quantity: 1 },
      ],
      email: "ok@example.com",
      name: "Ok",
    });
    expect(ok.success).toBe(true);
  });

  test("intra-cart group cap: a sibling insert earlier in the same batch counts (no oversell)", async () => {
    // Two events share a group capped at 3. A single cart asks for 2 + 2 = 4.
    // The second INSERT's capacity check must see the first INSERT from the
    // same atomic batch, so it is refused — booking the first line (2) and
    // declining the second rather than overselling the group to 4. The
    // all-or-nothing policy lives one layer up (ensureAllBookings); this layer
    // fulfils greedily but must never exceed the cap.
    const group = await createTestGroup({
      maxAttendees: 3,
      name: "cart-accum",
      slug: "cart-accum",
    });
    const e1 = await createTestEvent({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-accum-a",
    });
    const e2 = await createTestEvent({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-accum-b",
    });
    const result = await createAttendeeAtomic({
      bookings: [
        { eventId: e1.id, quantity: 2 },
        { eventId: e2.id, quantity: 2 },
      ],
      email: "cart@example.com",
      name: "Cart",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.attendees.length).toBe(1);
    expect((await getAttendeesRaw(e1.id))[0]!.quantity).toBe(2);
    expect((await getAttendeesRaw(e2.id)).length).toBe(0);
  });

  test("intra-cart group cap: a cart that exactly fills the group across events succeeds", async () => {
    const group = await createTestGroup({
      maxAttendees: 3,
      name: "cart-fill",
      slug: "cart-fill",
    });
    const e1 = await createTestEvent({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-fill-a",
    });
    const e2 = await createTestEvent({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-fill-b",
    });
    const result = await createAttendeeAtomic({
      bookings: [
        { eventId: e1.id, quantity: 1 },
        { eventId: e2.id, quantity: 2 },
      ],
      email: "fill@example.com",
      name: "Fill",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.attendees.length).toBe(2);
    expect((await getAttendeesRaw(e1.id))[0]!.quantity).toBe(1);
    expect((await getAttendeesRaw(e2.id))[0]!.quantity).toBe(2);
  });

  test("intra-cart group cap is per-date for daily events booked on the same day", async () => {
    const group = await createTestGroup({
      maxAttendees: 3,
      name: "cart-daily",
      slug: "cart-daily",
    });
    const e1 = await createDailyTestEvent({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-daily-a",
    });
    const e2 = await createDailyTestEvent({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-daily-b",
    });
    const result = await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-01", eventId: e1.id, quantity: 2 },
        { date: "2026-05-01", eventId: e2.id, quantity: 2 },
      ],
      email: "daily-cart@example.com",
      name: "DailyCart",
    });
    // 2 + 2 = 4 on the same date > cap 3: first fits, second refused.
    expect(result.success).toBe(true);
    if (result.success) expect(result.attendees.length).toBe(1);
    expect((await getAttendeesRaw(e1.id)).length).toBe(1);
    expect((await getAttendeesRaw(e2.id)).length).toBe(0);
  });

  test("intra-cart daily group cap is independent across different dates", async () => {
    const group = await createTestGroup({
      maxAttendees: 3,
      name: "cart-daily-dates",
      slug: "cart-daily-dates",
    });
    const e1 = await createDailyTestEvent({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-dates-a",
    });
    const e2 = await createDailyTestEvent({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-dates-b",
    });
    // Each day independently holds 3; both lines sit exactly at the per-day cap.
    const result = await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-01", eventId: e1.id, quantity: 3 },
        { date: "2026-05-02", eventId: e2.id, quantity: 3 },
      ],
      email: "spread@example.com",
      name: "Spread",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.attendees.length).toBe(2);
    expect((await getAttendeesRaw(e1.id))[0]!.quantity).toBe(3);
    expect((await getAttendeesRaw(e2.id))[0]!.quantity).toBe(3);
  });

  test("dateToRange produces half-open [start, end) with 1-day default", () => {
    expect(dateToRange("2026-04-15")).toEqual({
      endAt: "2026-04-16T00:00:00.000Z",
      startAt: "2026-04-15T00:00:00Z",
    });
    expect(dateToRange("2026-04-15", 3)).toEqual({
      endAt: "2026-04-18T00:00:00.000Z",
      startAt: "2026-04-15T00:00:00Z",
    });
  });
});

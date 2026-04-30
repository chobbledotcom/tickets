import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getActiveEventStats } from "#shared/db/attendees.ts";
import { getAllEvents } from "#shared/db/events.ts";
import {
  createPaidTestAttendee,
  createTestEvent,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("db > attendees > getActiveEventStats", { db: true }, () => {
  test("returns zeros for empty events", async () => {
    const stats = await getActiveEventStats([]);
    expect(stats).toEqual({ attendees: 0, income: 0, tickets: 0 });
  });

  test("returns zeros when all events inactive", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      unitPrice: 500,
    });
    await createPaidTestAttendee(
      event.id,
      "Alice",
      "alice@example.com",
      "pay_1",
      1000,
    );
    const events = await getAllEvents();
    const inactive = events.map((e) => ({ ...e, active: false }));
    const stats = await getActiveEventStats(inactive);
    expect(stats).toEqual({ attendees: 0, income: 0, tickets: 0 });
  });

  test("counts tickets and sums income for active events", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      unitPrice: 500,
    });
    await createPaidTestAttendee(
      event.id,
      "Alice",
      "alice@example.com",
      "pay_1",
      1000,
    );
    await createPaidTestAttendee(
      event.id,
      "Bob",
      "bob@example.com",
      "pay_2",
      2000,
    );
    const events = await getAllEvents();
    const stats = await getActiveEventStats(events);
    expect(stats.tickets).toBe(2);
    expect(stats.income).toBe(3000);
    expect(stats.attendees).toBe(2);
  });

  test("excludes inactive events", async () => {
    const event1 = await createTestEvent({
      maxAttendees: 50,
      unitPrice: 500,
    });
    const event2 = await createTestEvent({
      maxAttendees: 50,
      unitPrice: 500,
    });
    await createPaidTestAttendee(
      event1.id,
      "Alice",
      "alice@example.com",
      "pay_1",
      1000,
    );
    await createPaidTestAttendee(
      event2.id,
      "Bob",
      "bob@example.com",
      "pay_2",
      2000,
    );
    const events = await getAllEvents();
    const mixed = events.map((e) =>
      e.id === event2.id ? { ...e, active: false } : e,
    );
    const stats = await getActiveEventStats(mixed);
    expect(stats.tickets).toBe(1);
    expect(stats.income).toBe(1000);
    expect(stats.attendees).toBe(1);
  });

  test("treats non-numeric price_paid as zero", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      unitPrice: 0,
    });
    await createPaidTestAttendee(
      event.id,
      "Free Alice",
      "free@example.com",
      "",
      0,
    );
    const events = await getAllEvents();
    const stats = await getActiveEventStats(events);
    expect(stats.tickets).toBe(1);
    expect(stats.income).toBe(0);
    expect(stats.attendees).toBe(1);
  });
});

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decryptAttendees, getNewestAttendeesRaw } from "#lib/db/attendees.ts";
import {
  createTestAttendee,
  createTestEvent,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

describeWithEnv("db > attendees > getNewestAttendeesRaw", { db: true }, () => {
  test("returns attendees across events ordered by newest first", async () => {
    const event1 = await createTestEvent({ maxAttendees: 10 });
    const event2 = await createTestEvent({ maxAttendees: 10 });

    await createTestAttendee(
      event1.id,
      event1.slug,
      "First",
      "first@example.com",
    );
    await createTestAttendee(
      event2.id,
      event2.slug,
      "Second",
      "second@example.com",
    );
    await createTestAttendee(
      event1.id,
      event1.slug,
      "Third",
      "third@example.com",
    );

    const privateKey = await getTestPrivateKey();
    const raw = await getNewestAttendeesRaw(10);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees.length).toBe(3);
    // Newest first
    expect(attendees[0]?.name).toBe("Third");
  });

  test("respects limit", async () => {
    const event = await createTestEvent({ maxAttendees: 10 });
    for (let i = 0; i < 3; i++) {
      await createTestAttendee(
        event.id,
        event.slug,
        `Name${i}`,
        `n${i}@example.com`,
      );
    }

    const raw = await getNewestAttendeesRaw(2);
    expect(raw.length).toBe(2);
  });

  test("returns empty array when no attendees", async () => {
    const raw = await getNewestAttendeesRaw(10);
    expect(raw).toEqual([]);
  });
});

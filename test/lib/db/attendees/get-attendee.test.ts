import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendee } from "#lib/db/attendees.ts";
import {
  createTestAttendee,
  createTestEvent,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

describeWithEnv("db > attendees > getAttendee", { db: true }, () => {
  test("returns null for missing attendee", async () => {
    const privateKey = await getTestPrivateKey();
    const attendee = await getAttendee(999, privateKey);
    expect(attendee).toBeNull();
  });

  test("returns attendee by id", async () => {
    const event = await createTestEvent({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const created = await createTestAttendee(
      event.id,
      event.slug,
      "John Doe",
      "john@example.com",
    );
    const privateKey = await getTestPrivateKey();
    const fetched = await getAttendee(created.id, privateKey);

    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe("John Doe");
  });
});

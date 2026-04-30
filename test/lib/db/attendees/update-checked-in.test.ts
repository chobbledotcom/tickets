import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  decryptAttendees,
  getAttendeesRaw,
  updateCheckedIn,
} from "#shared/db/attendees.ts";
import {
  createTestAttendee,
  createTestEvent,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

describeWithEnv("db > attendees > updateCheckedIn", { db: true }, () => {
  test("updates checked_in to true for existing attendee", async () => {
    const event = await createTestEvent({ maxAttendees: 100 });
    const attendee = await createTestAttendee(
      event.id,
      event.slug,
      "Check User",
      "check@example.com",
    );

    await updateCheckedIn(attendee.id, event.id, true);

    const privateKey = await getTestPrivateKey();
    const rows = await getAttendeesRaw(event.id);
    const decrypted = await decryptAttendees(rows, privateKey);
    expect(decrypted[0]?.checked_in).toBe(true);
  });

  test("updates checked_in back to false", async () => {
    const event = await createTestEvent({ maxAttendees: 100 });
    const attendee = await createTestAttendee(
      event.id,
      event.slug,
      "Check User",
      "check@example.com",
    );

    await updateCheckedIn(attendee.id, event.id, true);
    await updateCheckedIn(attendee.id, event.id, false);

    const privateKey = await getTestPrivateKey();
    const rows = await getAttendeesRaw(event.id);
    const decrypted = await decryptAttendees(rows, privateKey);
    expect(decrypted[0]?.checked_in).toBe(false);
  });
});

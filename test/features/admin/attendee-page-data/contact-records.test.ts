import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { base64ToBase64Url } from "#crypto/utils.ts";
import { execute } from "#db/client.ts";
import {
  hashEmail,
  hashPhone,
  saveContactRecord,
} from "#db/contact-preferences.ts";
import {
  EMPTY_CONTACT_RECORDS,
  loadContactRecords,
} from "#routes/admin/attendee-page-data.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testAttendee } from "#test-utils/factories.ts";
import { withTestSession } from "#test-utils/session.ts";

const SAVED_RECORD = {
  adminBookingCount: 2,
  adminNotes: "Needs a quiet room",
  contactCount: 3,
  lastContact: "2026-07-20T12:00:00Z",
  lastSubject: "Arrival details",
  publicBookingCount: 4,
  visits: 5,
};

describeWithEnv("attendee contact records", { db: true }, () => {
  test("returns the shared empty record when both contact channels are blank", async () => {
    const records = await loadContactRecords(
      testAttendee({ email: "  ", phone: "" }),
    );

    expect(records).toBe(EMPTY_CONTACT_RECORDS);
  });

  test("loads the one saved channel without inventing the blank channel", async () => {
    const email = "history@example.com";
    const hash = await hashEmail(email);
    await saveContactRecord(hash, SAVED_RECORD);

    const records = await withTestSession(() =>
      loadContactRecords(testAttendee({ email, phone: "" })),
    );

    expect(records).toEqual({
      email: { hashParam: base64ToBase64Url(hash), record: SAVED_RECORD },
      phone: null,
    });
  });

  test("ignores a whitespace email while loading a phone record", async () => {
    const phone = "+447700900123";
    const hash = await hashPhone(phone);

    const records = await withTestSession(() =>
      loadContactRecords(testAttendee({ email: " ", phone })),
    );

    expect(records.email).toBeNull();
    expect(records.phone?.hashParam).toBe(base64ToBase64Url(hash));
  });

  test("labels a corrupt contact note as contact history in the error log", async () => {
    const email = "corrupt-history@example.com";
    const hash = await hashEmail(email);
    await execute(
      "INSERT INTO contact_preferences (contact_hash, visits, stats_blob) VALUES (?, ?, ?)",
      [hash, 7, "corrupt"],
    );
    const errorSpy = spy(console, "error");
    try {
      const records = await withTestSession(() =>
        loadContactRecords(testAttendee({ email, phone: "" })),
      );

      expect(records.email?.record.visits).toBe(7);
      expect(errorSpy.calls[0]?.args[0]).toContain(
        `detail="contact history ${base64ToBase64Url(hash)}:`,
      );
    } finally {
      errorSpy.restore();
    }
  });
});

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decryptAttendees, getAttendeesRaw } from "#shared/db/attendees.ts";
import { getDb } from "#shared/db/client.ts";
import {
  bookAttendee,
  createTestAttendee,
  createTestListing,
  decryptFirstAttendee,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

describeWithEnv("db > attendees > decryptAttendees", { db: true }, () => {
  test("returns empty array when no attendees", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const privateKey = await getTestPrivateKey();
    const raw = await getAttendeesRaw(listing.id);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees).toEqual([]);
  });

  test("returns decrypted attendees for listing", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    await createTestAttendee(
      listing.id,
      listing.slug,
      "John Doe",
      "john@example.com",
    );
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Jane Doe",
      "jane@example.com",
    );

    const privateKey = await getTestPrivateKey();
    const raw = await getAttendeesRaw(listing.id);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees.length).toBe(2);
    const names = attendees.map((a) => a.name).sort();
    expect(names).toEqual(["Jane Doe", "John Doe"]);
  });

  test("decrypts phone when present", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });

    const result = await bookAttendee(listing, {
      email: "phone@example.com",
      name: "Phone Person",
      phone: "+44 7700 900000",
      quantity: 1,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.attendees[0]!.phone).toBe("+44 7700 900000");
    }

    const attendee = await decryptFirstAttendee(listing.id);
    expect(attendee.phone).toBe("+44 7700 900000");
    expect(attendee.name).toBe("Phone Person");
  });

  test("handles empty email, phone, address, and special_instructions strings", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });

    const result = await bookAttendee(listing, {
      address: "",
      email: "",
      name: "NoContact Person",
      phone: "",
      quantity: 1,
      special_instructions: "",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.attendees[0]!.email).toBe("");
      expect(result.attendees[0]!.phone).toBe("");
      expect(result.attendees[0]!.address).toBe("");
      expect(result.attendees[0]!.special_instructions).toBe("");
    }

    const attendee = await decryptFirstAttendee(listing.id);
    expect(attendee.email).toBe("");
    expect(attendee.phone).toBe("");
    expect(attendee.address).toBe("");
    expect(attendee.special_instructions).toBe("");
  });

  test("encrypts and decrypts non-empty special_instructions", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });

    const result = await bookAttendee(listing, {
      email: "inst@example.com",
      name: "Instructions Person",
      quantity: 1,
      special_instructions: "No nuts please\nAllergic to dairy",
    });

    expect(result.success).toBe(true);
    const attendee = await decryptFirstAttendee(listing.id);
    expect(attendee.special_instructions).toBe(
      "No nuts please\nAllergic to dairy",
    );
  });

  test("encrypts and decrypts non-empty address", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });

    const result = await bookAttendee(listing, {
      address: "123 Main St\nSpringfield\nIL 62701",
      email: "addr@example.com",
      name: "Address Person",
      quantity: 1,
    });

    expect(result.success).toBe(true);
    const attendee = await decryptFirstAttendee(listing.id);
    expect(attendee.address).toBe("123 Main St\nSpringfield\nIL 62701");
  });

  test("treats empty checked_in as false for pre-migration attendees", async () => {
    const listing = await createTestListing({ maxAttendees: 100 });
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Old User",
      "old@example.com",
    );

    // Simulate pre-migration state: set checked_in to empty string directly
    await getDb().execute({
      args: [listing.id],
      sql: `UPDATE attendees
            SET checked_in = ''
            WHERE id IN (
              SELECT attendee_id
              FROM listing_attendees
              WHERE listing_id = ?
            )`,
    });

    const privateKey = await getTestPrivateKey();
    const rows = await getAttendeesRaw(listing.id);
    expect((rows[0] as unknown as Record<string, unknown>).checked_in).toBe(0);

    const decrypted = await decryptAttendees(rows, privateKey);
    expect(decrypted[0]?.checked_in).toBe(false);
  });
});

describeWithEnv("db > attendees > decryptAttendeeOrNull", { db: true }, () => {
  test("returns null when row is null", async () => {
    const { decryptAttendeeOrNull } = await import("#shared/db/attendees.ts");
    const privateKey = await getTestPrivateKey();
    const result = await decryptAttendeeOrNull(null, privateKey);
    expect(result).toBeNull();
  });
});

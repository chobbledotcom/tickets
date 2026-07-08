import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  getContactRecord,
  hashEmail,
  hashPhone,
  recordContacts,
} from "#shared/db/contact-preferences.ts";
import {
  getBookingTokens,
  getRecentBookingTokens,
  recordBooking,
  syncAttendeeContactTokens,
  unrecordBooking,
} from "#shared/db/contact-tokens.ts";
import { describeWithEnv, getTestPrivateKey } from "#test-utils";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const syncToken = (
  ticketToken: string,
  before: { email: string; phone: string },
  after: { email: string; phone: string },
  privateKey: CryptoKey,
  hasBooking = true,
): Promise<void> =>
  syncAttendeeContactTokens({
    after,
    before,
    hasBooking,
    privateKey,
    source: "admin",
    ticketToken,
  });

describeWithEnv("contact-tokens", { db: true }, () => {
  test("recordBooking splits the count by source, leaving outreach stats intact", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("bookings@example.com");
    await recordContacts([hash], "Newsletter", pk);
    await recordBooking(hash, "public", "tok-pub-1");
    await recordBooking(hash, "public", "tok-pub-2");
    await recordBooking(hash, "admin", "tok-adm-1");

    const record = await getContactRecord(hash, pk);
    expect(record.publicBookingCount).toBe(2);
    expect(record.adminBookingCount).toBe(1);
    expect(record.contactCount).toBe(1);
    expect(record.lastSubject).toBe("Newsletter");
  });

  test("recordBooking needs no owner key", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("keyless@example.com");
    await recordBooking(hash, "public", "tok-keyless");
    expect((await getContactRecord(hash, pk)).publicBookingCount).toBe(1);
  });

  test("unrecordBooking reverses a recordBooking and clamps at zero", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("undo@example.com");
    await recordBooking(hash, "public", "tok-undo-1");
    await recordBooking(hash, "public", "tok-undo-2");
    await unrecordBooking(hash, "public");
    expect((await getContactRecord(hash, pk)).publicBookingCount).toBe(1);
    await unrecordBooking(hash, "public");
    await unrecordBooking(hash, "public");
    expect((await getContactRecord(hash, pk)).publicBookingCount).toBe(0);
  });

  test("recordBooking appends the booked token, tagged by source", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("tokens@example.com");
    await recordBooking(hash, "public", "tok-online");
    await recordBooking(hash, "admin", "tok-manual");
    expect(await getBookingTokens(hash, pk)).toEqual([
      { source: "public", token: "tok-online" },
      { source: "admin", token: "tok-manual" },
    ]);
  });

  test("getBookingTokens is empty for a contact with no bookings", async () => {
    const pk = await getTestPrivateKey();
    expect(
      await getBookingTokens(await hashEmail("nobody@example.com"), pk),
    ).toEqual([]);
  });

  test("getRecentBookingTokens decrypts only the newest token lines", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("recent-window@example.com");
    await execute(
      "INSERT INTO contact_preferences (contact_hash, last_activity, attendee_tokens_blob) VALUES (?, ?, ?)",
      [hash, 1, "not-an-owner-key-token\n"],
    );
    await recordBooking(hash, "public", "tok-newer");
    await recordBooking(hash, "admin", "tok-newest");

    expect(await getRecentBookingTokens(hash, pk, 1)).toEqual([
      { source: "admin", token: "tok-newest" },
    ]);
  });

  test("syncAttendeeContactTokens appends without bumping counts", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("readd@example.com");
    await recordBooking(hash, "public", "tok-first");
    await syncToken(
      "tok-moved",
      { email: "readd@example.com", phone: "" },
      { email: "readd@example.com", phone: "" },
      pk,
    );
    expect(await getBookingTokens(hash, pk)).toEqual([
      { source: "public", token: "tok-first" },
      { source: "admin", token: "tok-moved" },
    ]);
    const record = await getContactRecord(hash, pk);
    expect(record.publicBookingCount).toBe(1);
    expect(record.adminBookingCount).toBe(0);
  });

  test("syncAttendeeContactTokens re-homes a changed email, keeping source", async () => {
    const pk = await getTestPrivateKey();
    const oldHash = await hashEmail("old@example.com");
    const newHash = await hashEmail("new@example.com");
    await recordBooking(oldHash, "admin", "tok-move");
    await syncToken(
      "tok-move",
      { email: "old@example.com", phone: "" },
      { email: "new@example.com", phone: "" },
      pk,
    );
    expect(await getBookingTokens(oldHash, pk)).toEqual([]);
    expect(await getBookingTokens(newHash, pk)).toEqual([
      { source: "admin", token: "tok-move" },
    ]);
  });

  test("syncAttendeeContactTokens moves a changed phone too", async () => {
    const pk = await getTestPrivateKey();
    const oldHash = await hashPhone("07700 900001");
    const newHash = await hashPhone("07700 900002");
    await recordBooking(oldHash, "public", "tok-phone");
    await syncToken(
      "tok-phone",
      { email: "", phone: "07700 900001" },
      { email: "", phone: "07700 900002" },
      pk,
    );
    expect(await getBookingTokens(oldHash, pk)).toEqual([]);
    expect(await getBookingTokens(newHash, pk)).toEqual([
      { source: "public", token: "tok-phone" },
    ]);
  });

  test("syncAttendeeContactTokens does not duplicate an unchanged token", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("same@example.com");
    await recordBooking(hash, "public", "tok-same");
    await syncToken(
      "tok-same",
      { email: "same@example.com", phone: "" },
      { email: "same@example.com", phone: "" },
      pk,
    );
    expect(await getBookingTokens(hash, pk)).toEqual([
      { source: "public", token: "tok-same" },
    ]);
  });

  test("syncAttendeeContactTokens drops the link when a field is cleared", async () => {
    const pk = await getTestPrivateKey();
    const oldHash = await hashEmail("cleared@example.com");
    await recordBooking(oldHash, "admin", "tok-clear");
    await syncToken(
      "tok-clear",
      { email: "cleared@example.com", phone: "" },
      { email: "", phone: "" },
      pk,
    );
    expect(await getBookingTokens(oldHash, pk)).toEqual([]);
    const row = await queryOne<{ attendee_tokens_blob: string }>(
      "SELECT attendee_tokens_blob FROM contact_preferences WHERE contact_hash = ?",
      [oldHash],
    );
    expect(row?.attendee_tokens_blob).toBe("");
  });

  test("syncAttendeeContactTokens links a newly added contact field", async () => {
    const pk = await getTestPrivateKey();
    const newHash = await hashEmail("fresh@example.com");
    await syncToken(
      "tok-fresh",
      { email: "", phone: "" },
      { email: "fresh@example.com", phone: "" },
      pk,
    );
    expect(await getBookingTokens(newHash, pk)).toEqual([
      { source: "admin", token: "tok-fresh" },
    ]);
  });

  test("syncAttendeeContactTokens links a legacy moved contact with no old token", async () => {
    const pk = await getTestPrivateKey();
    const newHash = await hashEmail("legacy-fresh@example.com");
    await syncToken(
      "tok-legacy",
      { email: "legacy-old@example.com", phone: "" },
      { email: "legacy-fresh@example.com", phone: "" },
      pk,
    );
    expect(await getBookingTokens(newHash, pk)).toEqual([
      { source: "admin", token: "tok-legacy" },
    ]);
  });

  test("syncAttendeeContactTokens does not link a no-real-line attendee", async () => {
    const pk = await getTestPrivateKey();
    const newHash = await hashEmail("empty@example.com");
    await syncToken(
      "tok-empty",
      { email: "", phone: "" },
      { email: "empty@example.com", phone: "" },
      pk,
      false,
    );
    expect(await getBookingTokens(newHash, pk)).toEqual([]);
  });

  test("syncAttendeeContactTokens keeps a concurrent append while moving a token", async () => {
    const pk = await getTestPrivateKey();
    const oldHash = await hashEmail("race-old@example.com");
    const newHash = await hashEmail("race-new@example.com");
    await recordBooking(oldHash, "public", "tok-move");
    await recordBooking(oldHash, "admin", "tok-stay");
    await syncToken(
      "tok-move",
      { email: "race-old@example.com", phone: "" },
      { email: "race-new@example.com", phone: "" },
      pk,
    );
    expect(await getBookingTokens(oldHash, pk)).toEqual([
      { source: "admin", token: "tok-stay" },
    ]);
    expect(await getBookingTokens(newHash, pk)).toEqual([
      { source: "public", token: "tok-move" },
    ]);
  });

  test("a real create appends the new attendee's ticket token", async () => {
    const pk = await getTestPrivateKey();
    const listing = await createTestListing({ maxAttendees: 5, name: "Tok" });
    const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id }],
      email: "real-token@example.com",
      name: "Real",
    });
    expect(result.success).toBe(true);
    const token = result.success ? result.attendees[0]!.ticket_token : "";
    expect(
      await getBookingTokens(await hashEmail("real-token@example.com"), pk),
    ).toEqual([{ source: "public", token }]);
  });

  test("a no-quantity create does not append a ticket token", async () => {
    const pk = await getTestPrivateKey();
    const listing = await createTestListing({ maxAttendees: 5, name: "None" });
    await createTestAttendeeDirect(
      listing.id,
      "No Quantity",
      "noqty-token@example.com",
      0,
    );
    expect(
      await getBookingTokens(await hashEmail("noqty-token@example.com"), pk),
    ).toEqual([]);
  });

  test("removing the last moved token leaves an empty blob, not a stale newline", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("blank-line@example.com");
    await recordBooking(hash, "public", "tok-only");
    await syncToken(
      "tok-only",
      { email: "blank-line@example.com", phone: "" },
      { email: "", phone: "" },
      pk,
    );
    const row = await queryOne<{ attendee_tokens_blob: string }>(
      "SELECT attendee_tokens_blob FROM contact_preferences WHERE contact_hash = ?",
      [hash],
    );
    expect(row?.attendee_tokens_blob).toBe("");
  });
});

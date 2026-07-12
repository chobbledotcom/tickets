import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  forgetContact,
  getContactRecord,
  hashEmail,
  hashPhone,
  recordContacts,
} from "#shared/db/contact-preferences.ts";
import {
  getRecentBookingTokens,
  recordBookingActivity,
  syncAttendeeContactTokens,
  unrecordBooking,
} from "#shared/db/contact-tokens.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const syncToken = (
  ticketToken: string,
  before: { email: string; phone: string },
  after: { email: string; phone: string },
  privateKey: CryptoKey,
  hasBooking = true,
  firstRealBooking = false,
): Promise<void> =>
  syncAttendeeContactTokens({
    after,
    before,
    firstRealBooking,
    hasBooking,
    privateKey,
    source: "admin",
    ticketToken,
  });

const readAllTokens = (hash: string, privateKey: CryptoKey) =>
  getRecentBookingTokens(hash, privateKey, Number.MAX_SAFE_INTEGER);

const tokenBlobFor = async (hash: string): Promise<string> =>
  (
    await queryOne<{ attendee_tokens_blob: string }>(
      "SELECT attendee_tokens_blob FROM contact_preferences WHERE contact_hash = ?",
      [hash],
    )
  )?.attendee_tokens_blob ?? "";

const firstMarkerFrom = (blob: string): string =>
  blob.split("\n")[0]!.split("\t")[0]!;

const expectOneBookingVisit = async (
  hash: string,
  privateKey: CryptoKey,
  token: string,
): Promise<void> => {
  const record = await getContactRecord(hash, privateKey);
  expect(record.visits).toBe(1);
  expect(record.publicBookingCount).toBe(1);
  expect(await readAllTokens(hash, privateKey)).toEqual([
    { source: "public", token },
  ]);
};

describeWithEnv("contact-tokens", { db: true }, () => {
  test("recordBookingActivity splits the count by source, leaving outreach stats intact", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("bookings@example.com");
    await recordContacts([hash], "Newsletter", pk);
    await recordBookingActivity(hash, "public", "tok-pub-1");
    await recordBookingActivity(hash, "public", "tok-pub-2");
    await recordBookingActivity(hash, "admin", "tok-adm-1");

    const record = await getContactRecord(hash, pk);
    expect(record.publicBookingCount).toBe(2);
    expect(record.adminBookingCount).toBe(1);
    expect(record.contactCount).toBe(1);
    expect(record.lastSubject).toBe("Newsletter");
  });

  test("recordBookingActivity needs no owner key", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("keyless@example.com");
    await recordBookingActivity(hash, "public", "tok-keyless");
    expect((await getContactRecord(hash, pk)).publicBookingCount).toBe(1);
  });

  test("recordBookingActivity records missing booking history", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("recover-visit@example.com");
    await recordBookingActivity(hash, "public", "tok-recover-visit");

    await expectOneBookingVisit(hash, pk, "tok-recover-visit");
  });

  test("recordBookingActivity does not duplicate completed history", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("recover-complete@example.com");
    await recordBookingActivity(hash, "public", "tok-recover-complete");
    await recordBookingActivity(hash, "public", "tok-recover-complete");

    await expectOneBookingVisit(hash, pk, "tok-recover-complete");
  });

  test("unrecordBooking reverses a booking count and clamps at zero", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("undo@example.com");
    await recordBookingActivity(hash, "public", "tok-undo-1");
    await recordBookingActivity(hash, "public", "tok-undo-2");
    await unrecordBooking(hash, "public");
    expect((await getContactRecord(hash, pk)).publicBookingCount).toBe(1);
    await unrecordBooking(hash, "public");
    await unrecordBooking(hash, "public");
    expect((await getContactRecord(hash, pk)).publicBookingCount).toBe(0);
  });

  test("recordBookingActivity appends the booked token, tagged by source", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("tokens@example.com");
    await recordBookingActivity(hash, "public", "tok-online");
    await recordBookingActivity(hash, "admin", "tok-manual");
    expect(await readAllTokens(hash, pk)).toEqual([
      { source: "public", token: "tok-online" },
      { source: "admin", token: "tok-manual" },
    ]);
  });

  test("recordBookingActivity does not reuse one marker across contact rows", async () => {
    const pk = await getTestPrivateKey();
    const emailHash = await hashEmail("linked-token@example.com");
    const phoneHash = await hashPhone("07700 900111");
    await recordBookingActivity(emailHash, "public", "tok-linked-contact");
    await recordBookingActivity(phoneHash, "public", "tok-linked-contact");

    expect(firstMarkerFrom(await tokenBlobFor(emailHash))).not.toBe(
      firstMarkerFrom(await tokenBlobFor(phoneHash)),
    );
    expect(await readAllTokens(emailHash, pk)).toEqual([
      { source: "public", token: "tok-linked-contact" },
    ]);
    expect(await readAllTokens(phoneHash, pk)).toEqual([
      { source: "public", token: "tok-linked-contact" },
    ]);
  });

  test("getRecentBookingTokens is empty for a contact with no bookings", async () => {
    const pk = await getTestPrivateKey();
    expect(
      await readAllTokens(await hashEmail("nobody@example.com"), pk),
    ).toEqual([]);
  });

  test("getRecentBookingTokens decrypts only the newest token lines", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("recent-window@example.com");
    await execute(
      "INSERT INTO contact_preferences (contact_hash, last_activity, attendee_tokens_blob) VALUES (?, ?, ?)",
      [hash, 1, "not-an-owner-key-token\n"],
    );
    await recordBookingActivity(hash, "public", "tok-newer");
    await recordBookingActivity(hash, "admin", "tok-newest");

    expect(await getRecentBookingTokens(hash, pk, 1)).toEqual([
      { source: "admin", token: "tok-newest" },
    ]);
  });

  test("getRecentBookingTokens decrypts nothing for a zero limit", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("zero-window@example.com");
    await execute(
      "INSERT INTO contact_preferences (contact_hash, last_activity, attendee_tokens_blob) VALUES (?, ?, ?)",
      [hash, 1, "not-an-owner-key-token\n"],
    );

    expect(await getRecentBookingTokens(hash, pk, 0)).toEqual([]);
  });

  test("syncAttendeeContactTokens appends without bumping counts", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("readd@example.com");
    await recordBookingActivity(hash, "public", "tok-first");
    await syncToken(
      "tok-moved",
      { email: "readd@example.com", phone: "" },
      { email: "readd@example.com", phone: "" },
      pk,
    );
    expect(await readAllTokens(hash, pk)).toEqual([
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
    await recordBookingActivity(oldHash, "admin", "tok-move");
    await syncToken(
      "tok-move",
      { email: "old@example.com", phone: "" },
      { email: "new@example.com", phone: "" },
      pk,
    );
    expect(await readAllTokens(oldHash, pk)).toEqual([]);
    expect(await readAllTokens(newHash, pk)).toEqual([
      { source: "admin", token: "tok-move" },
    ]);
  });

  test("syncAttendeeContactTokens removes a moved token without decrypting unrelated lines", async () => {
    const pk = await getTestPrivateKey();
    const oldEmail = "marker-old@example.com";
    const newEmail = "marker-new@example.com";
    const oldHash = await hashEmail(oldEmail);
    const newHash = await hashEmail(newEmail);
    await execute(
      "INSERT INTO contact_preferences (contact_hash, last_activity, attendee_tokens_blob) VALUES (?, ?, ?)",
      [oldHash, 1, "not-an-owner-key-token\n"],
    );
    await recordBookingActivity(oldHash, "public", "tok-marker-move");

    await syncToken(
      "tok-marker-move",
      { email: oldEmail, phone: "" },
      { email: newEmail, phone: "" },
      pk,
    );

    expect(await readAllTokens(newHash, pk)).toEqual([
      { source: "public", token: "tok-marker-move" },
    ]);
    expect(await tokenBlobFor(oldHash)).toBe("not-an-owner-key-token\n");
  });

  test("syncAttendeeContactTokens moves a changed phone too", async () => {
    const pk = await getTestPrivateKey();
    const oldHash = await hashPhone("07700 900001");
    const newHash = await hashPhone("07700 900002");
    await recordBookingActivity(oldHash, "public", "tok-phone");
    await syncToken(
      "tok-phone",
      { email: "", phone: "07700 900001" },
      { email: "", phone: "07700 900002" },
      pk,
    );
    expect(await readAllTokens(oldHash, pk)).toEqual([]);
    expect(await readAllTokens(newHash, pk)).toEqual([
      { source: "public", token: "tok-phone" },
    ]);
  });

  test("syncAttendeeContactTokens does not duplicate an unchanged token", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("same@example.com");
    await recordBookingActivity(hash, "public", "tok-same");
    await syncToken(
      "tok-same",
      { email: "same@example.com", phone: "" },
      { email: "same@example.com", phone: "" },
      pk,
    );
    expect(await readAllTokens(hash, pk)).toEqual([
      { source: "public", token: "tok-same" },
    ]);
  });

  test("syncAttendeeContactTokens does not reorder history on an unchanged edit", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("order@example.com");
    await recordBookingActivity(hash, "public", "tok-first");
    await recordBookingActivity(hash, "admin", "tok-second");
    // Re-sync tok-first with the contact unchanged (before === after): the
    // token must stay in place, not be removed-and-re-appended to the end.
    await syncToken(
      "tok-first",
      { email: "order@example.com", phone: "" },
      { email: "order@example.com", phone: "" },
      pk,
    );
    expect(await readAllTokens(hash, pk)).toEqual([
      { source: "public", token: "tok-first" },
      { source: "admin", token: "tok-second" },
    ]);
  });

  test("syncAttendeeContactTokens does not recreate an erased unchanged contact", async () => {
    const pk = await getTestPrivateKey();
    const email = "erased-token@example.com";
    const hash = await hashEmail(email);
    await recordBookingActivity(hash, "public", "tok-erased");
    expect(await forgetContact(hash)).toBe(1);

    await syncToken(
      "tok-erased",
      { email, phone: "" },
      { email, phone: "" },
      pk,
    );

    expect(
      await queryOne<{ contact_hash: string }>(
        "SELECT contact_hash FROM contact_preferences WHERE contact_hash = ?",
        [hash],
      ),
    ).toBeNull();
  });

  test("syncAttendeeContactTokens drops the link when a field is cleared", async () => {
    const pk = await getTestPrivateKey();
    const oldHash = await hashEmail("cleared@example.com");
    await recordBookingActivity(oldHash, "admin", "tok-clear");
    await syncToken(
      "tok-clear",
      { email: "cleared@example.com", phone: "" },
      { email: "", phone: "" },
      pk,
    );
    expect(await readAllTokens(oldHash, pk)).toEqual([]);
    expect(await tokenBlobFor(oldHash)).toBe("");
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
    expect(await readAllTokens(newHash, pk)).toEqual([
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
    expect(await readAllTokens(newHash, pk)).toEqual([
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
    expect(await readAllTokens(newHash, pk)).toEqual([]);
  });

  test("syncAttendeeContactTokens keeps a concurrent append while moving a token", async () => {
    const pk = await getTestPrivateKey();
    const oldHash = await hashEmail("race-old@example.com");
    const newHash = await hashEmail("race-new@example.com");
    await recordBookingActivity(oldHash, "public", "tok-move");
    await recordBookingActivity(oldHash, "admin", "tok-stay");
    await syncToken(
      "tok-move",
      { email: "race-old@example.com", phone: "" },
      { email: "race-new@example.com", phone: "" },
      pk,
    );
    expect(await readAllTokens(oldHash, pk)).toEqual([
      { source: "admin", token: "tok-stay" },
    ]);
    expect(await readAllTokens(newHash, pk)).toEqual([
      { source: "public", token: "tok-move" },
    ]);
  });

  test("a real create appends the new attendee's ticket token", async () => {
    const pk = await getTestPrivateKey();
    const listing = await createTestListing({ maxAttendees: 5, name: "Tok" });
    const { createAttendeeAtomic } = await import(
      "#shared/db/attendees/api.ts"
    );
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id }],
      email: "real-token@example.com",
      name: "Real",
    });
    expect(result.success).toBe(true);
    const token = result.success ? result.attendees[0]!.ticket_token : "";
    expect(
      await readAllTokens(await hashEmail("real-token@example.com"), pk),
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
      await readAllTokens(await hashEmail("noqty-token@example.com"), pk),
    ).toEqual([]);
  });

  test("removing the last moved token leaves an empty blob, not a stale newline", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("blank-line@example.com");
    await recordBookingActivity(hash, "public", "tok-only");
    await syncToken(
      "tok-only",
      { email: "blank-line@example.com", phone: "" },
      { email: "", phone: "" },
      pk,
    );
    expect(await tokenBlobFor(hash)).toBe("");
  });
});

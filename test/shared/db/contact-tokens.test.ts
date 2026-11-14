import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#db/client.ts";
import {
  forgetContact,
  getContactRecord,
  hashEmail,
  hashPhone,
  recordContacts,
} from "#db/contact-preferences.ts";
import {
  getRecentBookingTokens,
  storedBookingSource,
  syncAttendeeContactTokens,
} from "#db/contact-tokens.ts";
import { sql } from "#db/sql.ts";
import { seedOrderActivity } from "#test-utils/contact-tokens.ts";
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

const recordEmailBooking = (
  email: string,
  source: "admin" | "public",
  ticketToken: string,
): Promise<void> => seedOrderActivity(email, "", source, ticketToken);

const tokenBlobFor = async (hash: string): Promise<string> =>
  (
    await queryOne<{ attendee_tokens_blob: string }>(
      sql`SELECT attendee_tokens_blob FROM contact_preferences WHERE contact_hash = ${hash}`,
    )
  )?.attendee_tokens_blob ?? "";

const firstMarkerFrom = (blob: string): string =>
  blob.split("\n")[0]!.split("\t")[0]!;

/** The key, and the hash of `email`; nearly every case needs both. */
const keyAndHash = async (
  email: string,
): Promise<{ pk: CryptoKey; hash: string }> => ({
  hash: await hashEmail(email),
  pk: await getTestPrivateKey(),
});

/** The test key, and a contact whose stored blob starts with one line nothing
 *  can decrypt, so a test can tell which lines a call actually reads. */
const unreadableLineContact = async (
  email: string,
): Promise<{ pk: CryptoKey; hash: string }> => {
  const { pk, hash } = await keyAndHash(email);
  await execute(
    sql`INSERT INTO contact_preferences (contact_hash, last_activity, attendee_tokens_blob) VALUES (${hash}, ${1}, ${"not-an-owner-key-token\n"})`,
  );
  return { hash, pk };
};

describeWithEnv("storedBookingSource", { db: true }, () => {
  test("reads the source the booking stored", async () => {
    const privateKey = await getTestPrivateKey();
    await seedOrderActivity(
      "sourced@example.com",
      "07700 900001",
      "public",
      "PUBTOKEN1",
    );
    await seedOrderActivity("walkin@example.com", "", "admin", "ADMTOKEN1");

    expect(
      await storedBookingSource(
        "sourced@example.com",
        "07700 900001",
        "PUBTOKEN1",
        privateKey,
      ),
    ).toBe("public");
    expect(
      await storedBookingSource(
        "walkin@example.com",
        "",
        "ADMTOKEN1",
        privateKey,
      ),
    ).toBe("admin");
  });

  test("reads a phone-only contact", async () => {
    const privateKey = await getTestPrivateKey();
    await seedOrderActivity("", "07700 900002", "admin", "PHONETOKEN1");

    expect(
      await storedBookingSource("", "07700 900002", "PHONETOKEN1", privateKey),
    ).toBe("admin");
  });

  test("answers null when no contact holds the token", async () => {
    const privateKey = await getTestPrivateKey();
    await seedOrderActivity("gone@example.com", "", "public", "GONETOKEN1");

    // The contact's other tokens answer nothing for a different booking.
    expect(
      await storedBookingSource(
        "gone@example.com",
        "",
        "OTHERTOKEN1",
        privateKey,
      ),
    ).toBeNull();
    expect(
      await storedBookingSource(
        "nobody@example.com",
        "",
        "GONETOKEN1",
        privateKey,
      ),
    ).toBeNull();
  });
});

describeWithEnv("contact-tokens", { db: true }, () => {
  test("order activity splits the count by source, leaving outreach stats intact", async () => {
    const email = "bookings@example.com";
    const { pk, hash } = await keyAndHash(email);
    await recordContacts([hash], "Newsletter", pk);
    await recordEmailBooking(email, "public", "tok-pub-1");
    await recordEmailBooking(email, "public", "tok-pub-2");
    await recordEmailBooking(email, "admin", "tok-adm-1");

    const record = await getContactRecord(hash, pk);
    expect(record.publicBookingCount).toBe(2);
    expect(record.adminBookingCount).toBe(1);
    expect(record.contactCount).toBe(1);
    expect(record.lastSubject).toBe("Newsletter");
  });

  test("order activity needs no owner key", async () => {
    const email = "keyless@example.com";
    const { pk, hash } = await keyAndHash(email);
    await recordEmailBooking(email, "public", "tok-keyless");
    expect((await getContactRecord(hash, pk)).publicBookingCount).toBe(1);
  });

  test("order activity appends the booked token, tagged by source", async () => {
    const email = "tokens@example.com";
    const { pk, hash } = await keyAndHash(email);
    await recordEmailBooking(email, "public", "tok-online");
    await recordEmailBooking(email, "admin", "tok-manual");
    expect(await readAllTokens(hash, pk)).toEqual([
      { source: "public", token: "tok-online" },
      { source: "admin", token: "tok-manual" },
    ]);
  });

  test("order activity does not reuse one marker across contact rows", async () => {
    const email = "linked-token@example.com";
    const phone = "07700 900111";
    const { pk, hash: emailHash } = await keyAndHash(email);
    const phoneHash = await hashPhone(phone);
    await seedOrderActivity(email, phone, "public", "tok-linked-contact");

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

  // A limit only governs how many stored lines a read touches, so each case
  // reads the contact whose blob starts with one line nothing can decrypt.
  const limitedReads: {
    what: string;
    email: string;
    record: readonly { source: "admin" | "public"; token: string }[];
    limit: number;
    expected: readonly { source: string; token: string }[];
  }[] = [
    {
      email: "recent-window@example.com",
      expected: [{ source: "admin", token: "tok-newest" }],
      limit: 1,
      record: [
        { source: "public", token: "tok-newer" },
        { source: "admin", token: "tok-newest" },
      ],
      what: "decrypts only the newest token lines",
    },
    {
      email: "zero-window@example.com",
      expected: [],
      limit: 0,
      record: [],
      what: "decrypts nothing for a zero limit",
    },
  ];

  for (const window of limitedReads) {
    test(`getRecentBookingTokens ${window.what}`, async () => {
      const { pk, hash } = await unreadableLineContact(window.email);
      for (const { source, token } of window.record) {
        await recordEmailBooking(window.email, source, token);
      }

      expect(await getRecentBookingTokens(hash, pk, window.limit)).toEqual(
        window.expected,
      );
    });
  }

  test("syncAttendeeContactTokens appends without bumping counts", async () => {
    const pk = await getTestPrivateKey();
    const email = "readd@example.com";
    const hash = await hashEmail(email);
    await recordEmailBooking(email, "public", "tok-first");
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
    await recordEmailBooking("old@example.com", "admin", "tok-move");
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
    const oldEmail = "marker-old@example.com";
    const newEmail = "marker-new@example.com";
    const { pk, hash: oldHash } = await unreadableLineContact(oldEmail);
    const newHash = await hashEmail(newEmail);
    await recordEmailBooking(oldEmail, "public", "tok-marker-move");

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
    await seedOrderActivity("", "07700 900001", "public", "tok-phone");
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
    const email = "same@example.com";
    const { pk, hash } = await keyAndHash(email);
    await recordEmailBooking(email, "public", "tok-same");
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
    const email = "order@example.com";
    const { pk, hash } = await keyAndHash(email);
    await recordEmailBooking(email, "public", "tok-first");
    await recordEmailBooking(email, "admin", "tok-second");
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
    const email = "erased-token@example.com";
    const { pk, hash } = await keyAndHash(email);
    await recordEmailBooking(email, "public", "tok-erased");
    expect(await forgetContact(hash)).toBe(1);

    await syncToken(
      "tok-erased",
      { email, phone: "" },
      { email, phone: "" },
      pk,
    );

    expect(
      await queryOne<{ contact_hash: string }>(
        sql`SELECT contact_hash FROM contact_preferences WHERE contact_hash = ${hash}`,
      ),
    ).toBeNull();
  });

  test("syncAttendeeContactTokens drops the link when a field is cleared", async () => {
    const oldEmail = "cleared@example.com";
    const { pk, hash: oldHash } = await keyAndHash(oldEmail);
    await recordEmailBooking(oldEmail, "admin", "tok-clear");
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
    const { pk, hash: newHash } = await keyAndHash("fresh@example.com");
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

  test("syncAttendeeContactTokens gives an added field the booking's stored source", async () => {
    const phone = "07700 900123";
    const { pk, hash: newHash } = await keyAndHash("added@example.com");
    await seedOrderActivity("", phone, "public", "tok-added");
    await syncToken(
      "tok-added",
      { email: "", phone },
      { email: "added@example.com", phone },
      pk,
    );
    expect(await readAllTokens(newHash, pk)).toEqual([
      { source: "public", token: "tok-added" },
    ]);
  });

  test("syncAttendeeContactTokens links a legacy moved contact with no old token", async () => {
    const { pk, hash: newHash } = await keyAndHash("legacy-fresh@example.com");
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
    const { pk, hash: newHash } = await keyAndHash("empty@example.com");
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
    const { pk, hash: oldHash } = await keyAndHash("race-old@example.com");
    const newHash = await hashEmail("race-new@example.com");
    await recordEmailBooking("race-old@example.com", "public", "tok-move");
    await recordEmailBooking("race-old@example.com", "admin", "tok-stay");
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
    const { attendeesApi } = await import("#db/attendees/api.ts");
    const result = await attendeesApi.createAttendeeAtomic({
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
    const email = "blank-line@example.com";
    const { pk, hash } = await keyAndHash(email);
    await recordEmailBooking(email, "public", "tok-only");
    await syncToken(
      "tok-only",
      { email: "blank-line@example.com", phone: "" },
      { email: "", phone: "" },
      pk,
    );
    expect(await tokenBlobFor(hash)).toBe("");
  });
});

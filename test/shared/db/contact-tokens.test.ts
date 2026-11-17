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
import {
  type Contact,
  type ContactCounts,
  emailOnly,
  type OrderActivityCase,
  orderActivityCases,
  type Source,
  type SyncCase,
  syncCases,
  type Token,
} from "#test-utils/db/contact-token-cases.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** The hash of the channel a contact names: the email when it has one. */
const contactHash = async ({ email, phone }: Contact): Promise<string> =>
  email === "" ? await hashPhone(phone) : await hashEmail(email);

/** Record one order-activity line on a contact row. */
const recordLine = (
  contact: Contact,
  source: Source,
  token: string,
): Promise<void> =>
  seedOrderActivity(contact.email, contact.phone, source, token);

/** Store one token line nothing can decrypt, so a test can tell which lines a
 *  call actually reads. */
const storeUnreadableLine = async (hash: string): Promise<void> => {
  await execute(
    sql`INSERT INTO contact_preferences (contact_hash, last_activity, attendee_tokens_blob) VALUES (${hash}, ${1}, ${"not-an-owner-key-token\n"})`,
  );
};

const syncToken = (
  ticketToken: string,
  before: Contact,
  after: Contact,
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

/** The tokens a contact row holds, as the stored order. */
const readContact = async (
  contact: Contact,
  privateKey: CryptoKey,
): Promise<Token[]> => readAllTokens(await contactHash(contact), privateKey);

const tokenBlobFor = async (hash: string): Promise<string> =>
  (
    await queryOne<{ attendee_tokens_blob: string }>(
      sql`SELECT attendee_tokens_blob FROM contact_preferences WHERE contact_hash = ${hash}`,
    )
  )?.attendee_tokens_blob ?? "";

const firstMarkerFrom = (blob: string): string =>
  blob.split("\n")[0]!.split("\t")[0]!;

/** Assert the booking counts one contact row holds. */
const expectCounts = async (
  { admin, contact, public: publicCount }: ContactCounts,
  privateKey: CryptoKey,
): Promise<void> => {
  const record = await getContactRecord(await contactHash(contact), privateKey);
  expect(record.publicBookingCount).toBe(publicCount);
  expect(record.adminBookingCount).toBe(admin);
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
    const contact = emailOnly("bookings@example.com");
    const pk = await getTestPrivateKey();
    const hash = await contactHash(contact);
    await recordContacts([hash], "Newsletter", pk);
    for (const [source, token] of [
      ["public", "tok-pub-1"],
      ["public", "tok-pub-2"],
      ["admin", "tok-adm-1"],
    ] as const) {
      await recordLine(contact, source, token);
    }

    const record = await getContactRecord(hash, pk);
    expect(record.publicBookingCount).toBe(2);
    expect(record.adminBookingCount).toBe(1);
    expect(record.contactCount).toBe(1);
    expect(record.lastSubject).toBe("Newsletter");
  });

  /** Seed one order-activity case, then assert what each contact reads. */
  const expectOrderActivity = async (
    activity: OrderActivityCase,
  ): Promise<void> => {
    const pk = await getTestPrivateKey();
    for (const [contact, { source, token }] of activity.bookings) {
      await recordLine(contact, source, token);
    }
    for (const [contact, tokens] of activity.reads ?? []) {
      expect(await readContact(contact, pk)).toEqual(tokens);
    }
    if (activity.counts) await expectCounts(activity.counts, pk);
    const [left, right] = activity.markers ?? [];
    if (left && right) {
      expect(
        firstMarkerFrom(await tokenBlobFor(await contactHash(left))),
      ).not.toBe(firstMarkerFrom(await tokenBlobFor(await contactHash(right))));
    }
  };

  for (const activity of orderActivityCases) {
    test(activity.name, () => expectOrderActivity(activity));
  }

  test("getRecentBookingTokens is empty for a contact with no bookings", async () => {
    const pk = await getTestPrivateKey();
    expect(
      await readAllTokens(await hashEmail("nobody@example.com"), pk),
    ).toEqual([]);
  });

  // A limit only governs how many stored lines a read touches, so each case
  // reads the contact whose blob starts with one line nothing can decrypt.
  type LimitedRead = {
    email: string;
    expected: readonly Token[];
    limit: number;
    record: readonly Token[];
    what: string;
  };

  const limitedReads: readonly LimitedRead[] = [
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

  /** Stage an unreadable first line, then assert what the limit reads. */
  const expectLimitedRead = async (window: LimitedRead): Promise<void> => {
    const pk = await getTestPrivateKey();
    const contact = emailOnly(window.email);
    const hash = await contactHash(contact);
    await storeUnreadableLine(hash);
    for (const { source, token } of window.record) {
      await recordLine(contact, source, token);
    }
    expect(await getRecentBookingTokens(hash, pk, window.limit)).toEqual(
      window.expected,
    );
  };

  for (const window of limitedReads) {
    test(`getRecentBookingTokens ${window.what}`, () =>
      expectLimitedRead(window));
  }

  /** Seed one sync case, run its move, then assert each read and the blob. */
  const expectSync = async (syncCase: SyncCase): Promise<void> => {
    const pk = await getTestPrivateKey();
    if (syncCase.seedUnreadable) {
      await storeUnreadableLine(await contactHash(syncCase.from));
    }
    for (const { source, token } of syncCase.seed ?? []) {
      await recordLine(syncCase.from, source, token);
    }
    await syncToken(
      syncCase.token,
      syncCase.from,
      syncCase.to,
      pk,
      syncCase.hasBooking,
    );
    for (const [contact, tokens] of syncCase.reads) {
      expect(await readContact(contact, pk)).toEqual(tokens);
    }
    const { blob, counts } = syncCase;
    if (blob) {
      expect(await tokenBlobFor(await contactHash(blob.contact))).toBe(
        blob.blob,
      );
    }
    if (counts) await expectCounts(counts, pk);
  };

  for (const syncCase of syncCases) {
    test(syncCase.name, () => expectSync(syncCase));
  }

  test("syncAttendeeContactTokens does not recreate an erased unchanged contact", async () => {
    const contact = emailOnly("erased-token@example.com");
    const pk = await getTestPrivateKey();
    const hash = await contactHash(contact);
    await recordLine(contact, "public", "tok-erased");
    expect(await forgetContact(hash)).toBe(1);

    await syncToken("tok-erased", contact, contact, pk);

    expect(
      await queryOne<{ contact_hash: string }>(
        sql`SELECT contact_hash FROM contact_preferences WHERE contact_hash = ${hash}`,
      ),
    ).toBeNull();
  });

  test("syncAttendeeContactTokens adds to an unchanged contact whose last token moved away", async () => {
    const contact = emailOnly("emptied-token@example.com");
    const pk = await getTestPrivateKey();
    await recordLine(contact, "public", "tok-moved");
    await syncToken(
      "tok-moved",
      contact,
      emailOnly("moved-to@example.com"),
      pk,
    );
    expect(await tokenBlobFor(await contactHash(contact))).toBe("");

    await syncToken("tok-kept", contact, contact, pk);

    expect(await readContact(contact, pk)).toEqual([
      { source: "admin", token: "tok-kept" },
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
});

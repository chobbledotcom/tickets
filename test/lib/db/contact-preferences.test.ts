import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  contactHash,
  forgetContact,
  getContactCounts,
  getContactStats,
  getUnsubscribedHashSet,
  getVisits,
  hashEmail,
  hashPhone,
  isHashUnsubscribed,
  recordBookingStats,
  recordContacts,
  recordVisit,
  resubscribeHash,
  saveContactAdminNotes,
  unsubscribeHash,
} from "#shared/db/contact-preferences.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv, getTestPrivateKey } from "#test-utils";
import {
  createTestAttendeeDirect,
  createTestListing,
} from "#test-utils/db-helpers.ts";

const rowFor = (
  hash: string,
): Promise<{ visits: number; last_activity: number } | null> =>
  queryOne<{ visits: number; last_activity: number }>(
    "SELECT visits, last_activity FROM contact_preferences WHERE contact_hash = ?",
    [hash],
  );

const preferenceRowExists = async (hash: string): Promise<boolean> =>
  (await rowFor(hash)) !== null;

describeWithEnv("contact-preferences: hashing", { db: true }, () => {
  test("hashEmail normalizes case and surrounding whitespace", async () => {
    expect(await hashEmail("Bob@Example.com")).toBe(
      await hashEmail("  bob@example.com "),
    );
  });

  test("hashEmail preserves the legacy email blind-index input", async () => {
    expect(await hashEmail("Bob@Example.com")).toBe(
      await hmacHash("bob@example.com"),
    );
  });

  test("hashEmail distinguishes different addresses", async () => {
    expect(await hashEmail("a@example.com")).not.toBe(
      await hashEmail("b@example.com"),
    );
  });

  test("contactHash distinguishes email and sms channels", async () => {
    const value = "12345";
    expect(await contactHash("email", value)).not.toBe(
      await contactHash("sms", value),
    );
  });

  test("hashEmail equals contactHash on the email channel", async () => {
    expect(await hashEmail("x@example.com")).toBe(
      await contactHash("email", "x@example.com"),
    );
  });

  test("hashPhone equals contactHash on the sms channel", async () => {
    expect(await hashPhone("07700 900000")).toBe(
      await contactHash("sms", "07700 900000"),
    );
  });

  test("hashPhone normalizes equivalent phone formats to one hash", async () => {
    expect(await hashPhone("07700 900000")).toBe(
      await hashPhone("+44 7700 900000"),
    );
  });
});

describeWithEnv("contact-preferences: unsubscribe state", { db: true }, () => {
  test("an address is subscribed by default", async () => {
    expect(await isHashUnsubscribed(await hashEmail("new@example.com"))).toBe(
      false,
    );
  });

  test("unsubscribeHash marks the hash as unsubscribed", async () => {
    const hash = await hashEmail("leaver@example.com");
    await unsubscribeHash(hash);
    expect(await isHashUnsubscribed(hash)).toBe(true);
  });

  test("unsubscribeHash is idempotent", async () => {
    const hash = await hashEmail("twice@example.com");
    await unsubscribeHash(hash);
    await unsubscribeHash(hash);
    expect(await isHashUnsubscribed(hash)).toBe(true);
  });

  test("resubscribeHash clears the flag", async () => {
    const hash = await hashEmail("returner@example.com");
    await unsubscribeHash(hash);
    await resubscribeHash(hash);
    expect(await isHashUnsubscribed(hash)).toBe(false);
  });

  test("resubscribeHash is a no-op when not unsubscribed", async () => {
    const hash = await hashEmail("never@example.com");
    await resubscribeHash(hash);
    expect(await isHashUnsubscribed(hash)).toBe(false);
  });

  test("getUnsubscribedHashSet returns only unsubscribed hashes", async () => {
    const one = await hashEmail("one@example.com");
    const two = await hashEmail("two@example.com");
    await unsubscribeHash(one);
    await unsubscribeHash(two);
    await recordVisit(await hashEmail("seeded@example.com"));

    const set = await getUnsubscribedHashSet();

    expect(set.has(one)).toBe(true);
    expect(set.has(two)).toBe(true);
    expect(set.has(await hashEmail("seeded@example.com"))).toBe(false);
  });

  test("unsubscribing a contacted row preserves its stats", async () => {
    const hash = await hashEmail("both@example.com");
    const pk = await getTestPrivateKey();
    await recordContacts([hash], "Hello", pk);
    await unsubscribeHash(hash);
    expect(await isHashUnsubscribed(hash)).toBe(true);
    expect((await getContactStats(hash, pk)).contactCount).toBe(1);
  });
});

describeWithEnv("contact-preferences: visit counter", { db: true }, () => {
  test("recordVisit seeds a row at visits 1 and sets last_activity", async () => {
    const hash = await hashEmail("first@example.com");
    const before = Date.now();
    await recordVisit(hash);
    const row = await rowFor(hash);
    expect(row?.visits).toBe(1);
    expect(row?.last_activity).toBeGreaterThanOrEqual(before);
    expect(row?.last_activity).toBeLessThanOrEqual(Date.now());
  });

  test("recordVisit increments visits once per call", async () => {
    const hash = await hashEmail("repeat@example.com");
    await recordVisit(hash);
    await recordVisit(hash);
    await recordVisit(hash);
    expect((await rowFor(hash))?.visits).toBe(3);
  });

  test("getVisits reads the plaintext count, 0 when absent", async () => {
    const hash = await hashEmail("counted@example.com");
    expect(await getVisits(hash)).toBe(0);
    await recordVisit(hash);
    await recordVisit(hash);
    expect(await getVisits(hash)).toBe(2);
  });

  test("recordVisit on a phone hash counts separately from email", async () => {
    const email = await hashEmail("dual@example.com");
    const phone = await hashPhone("07700 900111");
    await recordVisit(email);
    await recordVisit(phone);
    await recordVisit(phone);
    expect(await getVisits(email)).toBe(1);
    expect(await getVisits(phone)).toBe(2);
  });
});

describeWithEnv("contact-preferences: erasure", { db: true }, () => {
  test("forgetContact deletes only the targeted hash", async () => {
    const target = await hashEmail("forget@example.com");
    const keep = await hashEmail("keep@example.com");
    await recordVisit(target);
    await recordVisit(keep);

    await forgetContact(target);

    expect(await preferenceRowExists(target)).toBe(false);
    expect(await preferenceRowExists(keep)).toBe(true);
  });

  test("forgetContact reports one deleted row when a record existed", async () => {
    const hash = await hashEmail("counted@example.com");
    await recordVisit(hash);
    expect(await forgetContact(hash)).toBe(1);
  });

  test("forgetContact is a no-op for an unknown hash", async () => {
    const deleted = await forgetContact(await hashEmail("ghost@example.com"));
    expect(deleted).toBe(0);
    expect(
      await preferenceRowExists(await hashEmail("ghost@example.com")),
    ).toBe(false);
  });
});

describeWithEnv("contact-preferences: contact history", { db: true }, () => {
  test("an unseen address has zeroed stats", async () => {
    const pk = await getTestPrivateKey();
    expect(
      await getContactStats(await hashEmail("unseen@example.com"), pk),
    ).toEqual({
      adminNotes: "",
      bookingCount: 0,
      contactCount: 0,
      lastBookedOnline: false,
      lastBookingDate: "",
      lastContact: "",
      lastSubject: "",
    });
  });

  test("a visited address has zero contacts", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("booked@example.com");
    await recordVisit(hash);
    expect((await getContactStats(hash, pk)).contactCount).toBe(0);
  });

  test("legacy stats blobs default newly-added fields", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("legacy@example.com");
    const encrypted = await encryptWithOwnerKey(
      JSON.stringify({}),
      settings.publicKey,
    );
    await execute(
      "INSERT INTO contact_preferences (contact_hash, stats_blob) VALUES (?, ?)",
      [hash, encrypted],
    );

    expect(await getContactStats(hash, pk)).toEqual({
      adminNotes: "",
      bookingCount: 0,
      contactCount: 0,
      lastBookedOnline: false,
      lastBookingDate: "",
      lastContact: "",
      lastSubject: "",
    });
  });

  test("recordContacts bumps count and stores subject + time", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("contacted@example.com");
    await recordContacts([hash], "First campaign", pk);
    await recordContacts([hash], "Second campaign", pk);

    const stats = await getContactStats(hash, pk);
    expect(stats.contactCount).toBe(2);
    expect(stats.lastSubject).toBe("Second campaign");
    expect(stats.lastContact).not.toBe("");
  });

  test("recordContacts sets last_activity without touching visits", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("outreach@example.com");
    await recordVisit(hash);
    await recordVisit(hash);
    const before = Date.now();
    await recordContacts([hash], "Newsletter", pk);
    const row = await rowFor(hash);
    expect(row?.visits).toBe(2);
    expect(row?.last_activity).toBeGreaterThanOrEqual(before);
  });

  test("getContactCounts returns counts in order, zero for missing", async () => {
    const pk = await getTestPrivateKey();
    const seen = await hashEmail("seen@example.com");
    const missing = await hashEmail("missing@example.com");
    await recordContacts([seen], "Hi", pk);

    expect(await getContactCounts([seen, missing], pk)).toEqual([1, 0]);
  });

  test("getContactCounts and recordContacts are no-ops for an empty list", async () => {
    const pk = await getTestPrivateKey();
    expect(await getContactCounts([], pk)).toEqual([]);
    await recordContacts([], "Nothing", pk);
  });

  test("recordBookingStats bumps booking history while preserving email stats", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("bookings@example.com");
    await recordContacts([hash], "Newsletter", pk);
    await recordBookingStats([hash], false, pk);
    await recordBookingStats([hash], true, pk);

    const stats = await getContactStats(hash, pk);
    expect(stats.contactCount).toBe(1);
    expect(stats.bookingCount).toBe(2);
    expect(stats.lastBookedOnline).toBe(true);
    expect(stats.lastBookingDate).not.toBe("");
  });

  test("saveContactAdminNotes stores private notes without changing counts", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("notes@example.com");
    await recordBookingStats([hash], false, pk);
    await saveContactAdminNotes(hash, "**VIP** customer", pk);

    const stats = await getContactStats(hash, pk);
    expect(stats.adminNotes).toBe("**VIP** customer");
    expect(stats.bookingCount).toBe(1);
  });
});

describeWithEnv("contact-preferences: booking seed", { db: true }, () => {
  test("booking with an email records a visit", async () => {
    const listing = await createTestListing({ maxAttendees: 5, name: "Gig" });
    await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
    expect(await getVisits(await hashEmail("alice@example.com"))).toBe(1);
  });

  test("booking with a phone records a phone visit", async () => {
    const listing = await createTestListing({ maxAttendees: 5, name: "Gig" });
    await createTestAttendeeDirect(
      listing.id,
      "Phoned",
      "phoned@example.com",
      1,
      "07700 900222",
    );
    expect(await getVisits(await hashPhone("07700 900222"))).toBe(1);
  });

  test("a multi-listing order records one visit, not one per booking", async () => {
    const a = await createTestListing({ maxAttendees: 5, name: "A" });
    const b = await createTestListing({ maxAttendees: 5, name: "B" });
    const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: a.id }, { listingId: b.id }],
      email: "multi@example.com",
      name: "Multi",
    });
    expect(result.success).toBe(true);
    expect(await getVisits(await hashEmail("multi@example.com"))).toBe(1);
  });

  test("booking without an email or phone records no row", async () => {
    const listing = await createTestListing({ maxAttendees: 5, name: "Gig" });
    await createTestAttendeeDirect(listing.id, "Nameless", "");
    expect(await preferenceRowExists(await hashEmail(""))).toBe(false);
  });
});

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryOne } from "#shared/db/client.ts";
import {
  contactHash,
  forgetContact,
  getContactCounts,
  getEmailStats,
  getUnsubscribedHashSet,
  getVisits,
  hashEmail,
  hashPhone,
  isHashUnsubscribed,
  recordContacts,
  recordVisit,
  resubscribeHash,
  unsubscribeHash,
} from "#shared/db/contact-preferences.ts";
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

  test("hashEmail distinguishes different addresses", async () => {
    expect(await hashEmail("a@example.com")).not.toBe(
      await hashEmail("b@example.com"),
    );
  });

  test("contactHash namespaces channels so email and sms of the same string differ", async () => {
    // The literal string is identical; only the channel prefix differs, so the
    // hashes must not collide across channels.
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
    // normalizePhone canonicalises both to +447700900000, so they collide.
    expect(await hashPhone("07700 900000")).toBe(
      await hashPhone("+44 7700 900000"),
    );
  });
});

describeWithEnv("contact-preferences: unsubscribe state", { db: true }, () => {
  test("an address is subscribed (not unsubscribed) by default", async () => {
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
    // A seeded-but-subscribed row must not appear.
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
    expect((await getEmailStats(hash, pk)).contactCount).toBe(1);
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

  test("recordVisit advances last_activity on a subsequent visit", async () => {
    const hash = await hashEmail("bumped@example.com");
    await recordVisit(hash);
    const first = (await rowFor(hash))!.last_activity;
    // Force a later timestamp than the first write.
    await new Promise((r) => setTimeout(r, 5));
    await recordVisit(hash);
    expect((await rowFor(hash))!.last_activity).toBeGreaterThanOrEqual(first);
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

  test("forgetContact is a no-op for an unknown hash", async () => {
    // Must not throw when nothing matches.
    await forgetContact(await hashEmail("ghost@example.com"));
    expect(
      await preferenceRowExists(await hashEmail("ghost@example.com")),
    ).toBe(false);
  });
});

describeWithEnv("contact-preferences: contact history", { db: true }, () => {
  test("an unseen address has zeroed stats", async () => {
    const pk = await getTestPrivateKey();
    expect(
      await getEmailStats(await hashEmail("unseen@example.com"), pk),
    ).toEqual({ contactCount: 0, lastContact: "", lastSubject: "" });
  });

  test("a visited (booked) address has zero contacts", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("booked@example.com");
    await recordVisit(hash);
    expect((await getEmailStats(hash, pk)).contactCount).toBe(0);
  });

  test("recordContacts bumps count and stores subject + time", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("contacted@example.com");
    await recordContacts([hash], "First campaign", pk);
    await recordContacts([hash], "Second campaign", pk);

    const stats = await getEmailStats(hash, pk);
    expect(stats.contactCount).toBe(2);
    expect(stats.lastSubject).toBe("Second campaign");
    expect(stats.lastContact).not.toBe("");
  });

  test("recordContacts sets last_activity without touching visits", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("outreach@example.com");
    // Two bookings first, then an outreach: the outreach must bump
    // last_activity (so the row isn't pruned) but leave the visit count alone.
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
    await recordContacts([], "Nothing", pk); // must not throw
  });
});

describeWithEnv("contact-preferences: booking seed", { db: true }, () => {
  test("booking with an email seeds a preferences row", async () => {
    const listing = await createTestListing({ maxAttendees: 5, name: "Gig" });
    await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
    expect(
      await preferenceRowExists(await hashEmail("alice@example.com")),
    ).toBe(true);
  });

  test("booking with a phone seeds a phone preferences row", async () => {
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

  test("booking without an email or phone seeds no row", async () => {
    const listing = await createTestListing({ maxAttendees: 5, name: "Gig" });
    await createTestAttendeeDirect(listing.id, "Nameless", "");
    expect(await preferenceRowExists(await hashEmail(""))).toBe(false);
  });
});

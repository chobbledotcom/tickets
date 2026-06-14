import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryOne } from "#shared/db/client.ts";
import {
  ensureEmailPreference,
  getContactCounts,
  getEmailStats,
  getUnsubscribedHashSet,
  hashEmail,
  isHashUnsubscribed,
  recordContacts,
  resubscribeHash,
  unsubscribeHash,
} from "#shared/db/email-preferences.ts";
import { describeWithEnv, getTestPrivateKey } from "#test-utils";
import {
  createTestAttendeeDirect,
  createTestListing,
} from "#test-utils/db-helpers.ts";

const preferenceRowExists = async (email: string): Promise<boolean> =>
  (await queryOne<{ email_hash: string }>(
    "SELECT email_hash FROM email_preferences WHERE email_hash = ?",
    [await hashEmail(email)],
  )) !== null;

describeWithEnv("email-preferences: unsubscribe state", { db: true }, () => {
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
    await ensureEmailPreference(await hashEmail("seeded@example.com"));

    const set = await getUnsubscribedHashSet();

    expect(set.has(one)).toBe(true);
    expect(set.has(two)).toBe(true);
    expect(set.has(await hashEmail("seeded@example.com"))).toBe(false);
  });

  test("unsubscribing a seeded row preserves its stats", async () => {
    const hash = await hashEmail("both@example.com");
    const pk = await getTestPrivateKey();
    await recordContacts([hash], "Hello", pk);
    await unsubscribeHash(hash);
    expect(await isHashUnsubscribed(hash)).toBe(true);
    expect((await getEmailStats(hash, pk)).contactCount).toBe(1);
  });
});

describeWithEnv("email-preferences: contact history", { db: true }, () => {
  test("an unseen address has zeroed stats", async () => {
    const pk = await getTestPrivateKey();
    expect(
      await getEmailStats(await hashEmail("unseen@example.com"), pk),
    ).toEqual({ contactCount: 0, lastContact: "", lastSubject: "" });
  });

  test("a seeded (booked) address has zero contacts", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("booked@example.com");
    await ensureEmailPreference(hash);
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

describeWithEnv("email-preferences: booking seed", { db: true }, () => {
  test("booking with an email seeds a preferences row", async () => {
    const listing = await createTestListing({ maxAttendees: 5, name: "Gig" });
    await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
    expect(await preferenceRowExists("alice@example.com")).toBe(true);
  });

  test("booking without an email seeds no row", async () => {
    const listing = await createTestListing({ maxAttendees: 5, name: "Gig" });
    await createTestAttendeeDirect(listing.id, "Nameless", "");
    expect(await preferenceRowExists("")).toBe(false);
  });
});

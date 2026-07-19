import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  contactHash,
  forgetContact,
  fromContactHashParam,
  getContactCountFields,
  getContactCounts,
  getContactRecord,
  getUnsubscribedHashSet,
  getVisits,
  hashEmail,
  hashPhone,
  isHashUnsubscribed,
  recordContacts,
  resubscribeHash,
  saveContactRecord,
  toContactHashParam,
  unsubscribeHash,
} from "#shared/db/contact-preferences.ts";
import { settings } from "#shared/db/settings.ts";
import { setContactVisits } from "#test-utils/contact-preferences.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";

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

  test("a contact hash round-trips through its URL-safe param", async () => {
    // base64 hashes can contain +, / and =, which break a URL path segment;
    // the param form must strip them and decode back to the exact hash.
    const hash = await hashEmail("urlsafe@example.com");
    const param = toContactHashParam(hash);
    expect(param).not.toMatch(/[+/=]/);
    expect(fromContactHashParam(param)).toBe(hash);
  });

  test("toContactHashParam makes a slash-bearing base64 hash URL-safe", () => {
    // Synthetic base64 with the exact characters that break path routing.
    const raw = "ab+cd/efGHij/klMNop/qrSTuv==";
    const param = toContactHashParam(raw);
    expect(param).not.toMatch(/[+/=]/);
    expect(fromContactHashParam(param)).toBe(raw);
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
    await setContactVisits(await hashEmail("seeded@example.com"), 1);

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
    expect((await getContactRecord(hash, pk)).contactCount).toBe(1);
  });
});

describeWithEnv("contact-preferences: visit counter", { db: true }, () => {
  test("getVisits reads the plaintext count, 0 when absent", async () => {
    const hash = await hashEmail("counted@example.com");
    expect(await getVisits(hash)).toBe(0);
    await setContactVisits(hash, 2);
    expect(await getVisits(hash)).toBe(2);
  });

  test("getVisits reads email and phone counts separately", async () => {
    const email = await hashEmail("dual@example.com");
    const phone = await hashPhone("07700 900111");
    await setContactVisits(email, 1);
    await setContactVisits(phone, 2);
    expect(await getVisits(email)).toBe(1);
    expect(await getVisits(phone)).toBe(2);
  });
});

describeWithEnv("contact-preferences: erasure", { db: true }, () => {
  test("forgetContact deletes only the targeted hash", async () => {
    const target = await hashEmail("forget@example.com");
    const keep = await hashEmail("keep@example.com");
    await setContactVisits(target, 1);
    await setContactVisits(keep, 1);

    await forgetContact(target);

    expect(await preferenceRowExists(target)).toBe(false);
    expect(await preferenceRowExists(keep)).toBe(true);
  });

  test("forgetContact reports one deleted row when a record existed", async () => {
    const hash = await hashEmail("counted@example.com");
    await setContactVisits(hash, 1);
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
      await getContactRecord(await hashEmail("unseen@example.com"), pk),
    ).toEqual({
      adminBookingCount: 0,
      adminNotes: "",
      contactCount: 0,
      lastContact: "",
      lastSubject: "",
      publicBookingCount: 0,
      visits: 0,
    });
  });

  test("a visited address has zero contacts", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("booked@example.com");
    await setContactVisits(hash, 1);
    expect((await getContactRecord(hash, pk)).contactCount).toBe(0);
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

    expect(await getContactRecord(hash, pk)).toEqual({
      adminBookingCount: 0,
      adminNotes: "",
      contactCount: 0,
      lastContact: "",
      lastSubject: "",
      publicBookingCount: 0,
      visits: 0,
    });
  });

  test("rejects wrong field types in an encrypted stats blob", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("invalid-stats@example.com");
    const encrypted = await encryptWithOwnerKey(
      JSON.stringify({ c: "2" }),
      settings.publicKey,
    );
    await execute(
      "INSERT INTO contact_preferences (contact_hash, stats_blob) VALUES (?, ?)",
      [hash, encrypted],
    );

    await expect(getContactRecord(hash, pk)).rejects.toThrow(
      "Invalid stored JSON in contact_preferences.stats_blob",
    );
  });

  test("getContactCountFields reads plaintext counts past a corrupt blob", async () => {
    const hash = await hashEmail("corrupt@example.com");
    await execute(
      "INSERT INTO contact_preferences (contact_hash, visits, public_booking_count, admin_booking_count, stats_blob) VALUES (?, ?, ?, ?, ?)",
      [hash, 4, 3, 1, "not-valid-ciphertext"],
    );

    // No private key, no decryption — the corrupt note is irrelevant, so the
    // editor can still recover the real counts to repair the row.
    expect(await getContactCountFields(hash)).toEqual({
      adminBookingCount: 1,
      publicBookingCount: 3,
      visits: 4,
    });
  });

  test("getContactCountFields defaults to zero for an unknown contact", async () => {
    expect(
      await getContactCountFields(await hashEmail("nobody@example.com")),
    ).toEqual({ adminBookingCount: 0, publicBookingCount: 0, visits: 0 });
  });

  test("recordContacts bumps count and stores subject + time", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("contacted@example.com");
    await recordContacts([hash], "First campaign", pk);
    await recordContacts([hash], "Second campaign", pk);

    const stats = await getContactRecord(hash, pk);
    expect(stats.contactCount).toBe(2);
    expect(stats.lastSubject).toBe("Second campaign");
    expect(stats.lastContact).not.toBe("");
  });

  test("recordContacts sets last_activity without touching visits", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("outreach@example.com");
    await setContactVisits(hash, 2);
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

  test("saveContactRecord overwrites the counts and the encrypted note", async () => {
    const pk = await getTestPrivateKey();
    const hash = await hashEmail("notes@example.com");
    await saveContactRecord(hash, {
      adminBookingCount: 3,
      adminNotes: "**VIP** customer",
      contactCount: 5,
      lastContact: "",
      lastSubject: "Welcome",
      publicBookingCount: 7,
      visits: 9,
    });

    const record = await getContactRecord(hash, pk);
    expect(record.adminNotes).toBe("**VIP** customer");
    expect(record.lastSubject).toBe("Welcome");
    expect(record.publicBookingCount).toBe(7);
    expect(record.adminBookingCount).toBe(3);
    expect(record.contactCount).toBe(5);
    expect(record.visits).toBe(9);
  });
});

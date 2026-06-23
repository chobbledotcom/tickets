import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decrypt, ENCRYPTION_PREFIX } from "#shared/crypto/encryption.ts";
import { HYBRID_PREFIX } from "#shared/crypto/keys.ts";
import {
  getAllActivityLog,
  getAttendeeActivityLog,
  getListingActivityLog,
  getListingWithActivityLog,
  logActivity,
} from "#shared/db/activityLog.ts";
import { queryOne } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import {
  createTestListing,
  describeWithEnv,
  withTestSession,
} from "#test-utils";

/** Raw (still-encrypted) stored message for an activity-log row. */
const rawMessage = async (id: number): Promise<string> =>
  (await queryOne<{ message: string }>(
    "SELECT message FROM activity_log WHERE id = ?",
    [id],
  ))!.message;

describeWithEnv("db > activity log", { db: true }, () => {
  test("logActivity creates log entry with message", async () => {
    const entry = await logActivity("Test action");

    expect(entry.id).toBe(1);
    expect(entry.message).toBe("Test action");
    expect(entry.listing_id).toBeNull();
    expect(entry.created).toBeDefined();
  });

  test("logActivity creates log entry with listing ID", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });
    const entry = await logActivity(
      "Created listing 'Test Listing'",
      listing.id,
    );

    expect(entry.listing_id).toBe(listing.id);
    expect(entry.message).toBe("Created listing 'Test Listing'");
  });

  test("stores messages encrypted with the owner key, not DB_ENCRYPTION_KEY", async () => {
    const entry = await logActivity("Sensitive note");
    const stored = await rawMessage(entry.id);

    // Owner-key (hybrid RSA+AES) format, not the env-key (enc:) format.
    expect(stored.startsWith(HYBRID_PREFIX)).toBe(true);
    expect(stored.startsWith(ENCRYPTION_PREFIX)).toBe(false);
    // A database dump plus DB_ENCRYPTION_KEY cannot read it: the env-key
    // decrypt rejects an owner-key payload outright.
    await expect(decrypt(stored)).rejects.toThrow();
  });

  test("reading owner-key entries fails closed without a session", async () => {
    await logActivity("Owner-key entry");

    await expect(getAllActivityLog()).rejects.toThrow(
      "Private key unavailable for session",
    );
  });

  test("falls back to the env key before a key pair is configured", async () => {
    // No public key yet (pre-setup); the error logger must still record.
    settings.setForTest({ public_key: "" });
    const entry = await logActivity("Pre-setup error");
    const stored = await rawMessage(entry.id);

    expect(stored.startsWith(ENCRYPTION_PREFIX)).toBe(true);
    expect(await decrypt(stored)).toBe("Pre-setup error");

    // Legacy env-key rows decrypt without a session in scope.
    const entries = await getAllActivityLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("Pre-setup error");
  });

  test("logActivity records an attendee_id and getAttendeeActivityLog filters by it", async () => {
    await logActivity("Unrelated entry");
    await logActivity("Balance paid", null, 42);
    await logActivity("Other attendee", null, 99);

    const entries = await withTestSession(() => getAttendeeActivityLog(42));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("Balance paid");
    expect(entries[0]!.attendee_id).toBe(42);
  });

  test("getListingActivityLog returns entries for specific listing", async () => {
    const listing1 = await createTestListing({
      maxAttendees: 50,
      name: "Listing One",
      thankYouUrl: "https://example.com",
    });
    const listing2 = await createTestListing({
      maxAttendees: 50,
      name: "Listing Two",
      thankYouUrl: "https://example.com",
    });

    await logActivity("Action for listing 1", listing1.id);
    await logActivity("Another action for listing 1", listing1.id);
    await logActivity("Action for listing 2", listing2.id);

    const listing1Log = await withTestSession(() =>
      getListingActivityLog(listing1.id),
    );
    // REST API also logs listing creation, so we have 3 entries for listing 1
    expect(listing1Log.length).toBe(3);
    expect(listing1Log[0]?.message).toBe("Another action for listing 1");
    expect(listing1Log[1]?.message).toBe("Action for listing 1");
  });

  test("getListingActivityLog returns empty array when no entries", async () => {
    const entries = await getListingActivityLog(999);
    expect(entries).toEqual([]);
  });

  test("getListingActivityLog respects limit", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });

    await logActivity("Action 1", listing.id);
    await logActivity("Action 2", listing.id);
    await logActivity("Action 3", listing.id);

    const entries = await withTestSession(() =>
      getListingActivityLog(listing.id, 2),
    );
    expect(entries.length).toBe(2);
  });

  test("getAllActivityLog returns all entries", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Test Listing",
      thankYouUrl: "https://example.com",
    });

    await logActivity("Global action");
    await logActivity("Listing action", listing.id);

    const entries = await withTestSession(() => getAllActivityLog());
    // REST API logs listing creation, so we have 3 entries total
    expect(entries.length).toBe(3);
  });

  test("getAllActivityLog returns entries in descending order", async () => {
    await logActivity("First action");
    await logActivity("Second action");
    await logActivity("Third action");

    const entries = await withTestSession(() => getAllActivityLog());
    expect(entries[0]?.message).toBe("Third action");
    expect(entries[1]?.message).toBe("Second action");
    expect(entries[2]?.message).toBe("First action");
  });

  test("getAllActivityLog respects limit", async () => {
    await logActivity("Action 1");
    await logActivity("Action 2");
    await logActivity("Action 3");

    const entries = await withTestSession(() => getAllActivityLog(2));
    expect(entries.length).toBe(2);
  });

  test("getListingWithActivityLog returns listing and activity log together", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      name: "Batch Test Listing",
      thankYouUrl: "https://example.com",
    });

    await logActivity("First action", listing.id);
    await logActivity("Second action", listing.id);

    const result = await withTestSession(() =>
      getListingWithActivityLog(listing.id),
    );
    expect(result).not.toBeNull();
    expect(result?.listing.id).toBe(listing.id);
    expect(result?.listing.name).toBe("Batch Test Listing");
    expect(result?.listing.attendee_count).toBe(0);
    // REST API logs listing creation + our 2 = 3
    expect(result?.entries.length).toBe(3);
    expect(result?.entries[0]?.message).toBe("Second action");
    expect(result?.entries[1]?.message).toBe("First action");
  });

  test("getListingWithActivityLog returns null for non-existent listing", async () => {
    const result = await getListingWithActivityLog(999);
    expect(result).toBeNull();
  });
});

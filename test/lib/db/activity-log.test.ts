import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getAllActivityLog,
  getListingActivityLog,
  getListingWithActivityLog,
  logActivity,
} from "#shared/db/activityLog.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

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

    const listing1Log = await getListingActivityLog(listing1.id);
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

    const entries = await getListingActivityLog(listing.id, 2);
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

    const entries = await getAllActivityLog();
    // REST API logs listing creation, so we have 3 entries total
    expect(entries.length).toBe(3);
  });

  test("getAllActivityLog returns entries in descending order", async () => {
    await logActivity("First action");
    await logActivity("Second action");
    await logActivity("Third action");

    const entries = await getAllActivityLog();
    expect(entries[0]?.message).toBe("Third action");
    expect(entries[1]?.message).toBe("Second action");
    expect(entries[2]?.message).toBe("First action");
  });

  test("getAllActivityLog respects limit", async () => {
    await logActivity("Action 1");
    await logActivity("Action 2");
    await logActivity("Action 3");

    const entries = await getAllActivityLog(2);
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

    const result = await getListingWithActivityLog(listing.id);
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

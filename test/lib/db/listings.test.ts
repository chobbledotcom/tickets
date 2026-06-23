import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { revenueAccount } from "#shared/accounting/accounts.ts";
import { accountBalance } from "#shared/accounting/queries.ts";
import {
  getAllActivityLog,
  getListingActivityLog,
  logActivity,
} from "#shared/db/activityLog.ts";
import {
  createAttendeeAtomic,
  decryptAttendees,
  getAttendeeNamesByIds,
  getAttendeeRaw,
  getAttendeesRaw,
} from "#shared/db/attendees.ts";
import { getDb, queryAll, queryOne } from "#shared/db/client.ts";
import {
  computeSlugIndex,
  deleteListing,
  getAllListings,
  getListing,
  getListingNamesByIds,
  getListingsBySlugsBatch,
  getListingWithAttendeeRaw,
  getListingWithAttendeesRaw,
  getListingWithCount,
  isSlugTaken,
  listingIncomeSubquery,
  listingRevenueBreakdown,
  listingsTable,
  writeClosesAt,
  writeListingDate,
} from "#shared/db/listings.ts";
import {
  finalizeSession as finalizePaymentSession,
  isSessionProcessed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import {
  answersTable,
  getAttendeeAnswersBatch,
  questionsTable,
  saveAttendeeAnswers,
  setListingQuestions,
} from "#shared/db/questions.ts";
import { MAX_DURATION_DAYS } from "#shared/types.ts";
import {
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  getTestPrivateKey,
  withTestSession,
} from "#test-utils";
import {
  postAttendeeRefund,
  postListingSale,
  postWriteoffAdjustment,
} from "#test-utils/ledger.ts";

describeWithEnv("db > listings", { db: true, triggers: true }, () => {
  describe("CRUD", () => {
    test("createListing creates listing with correct properties", async () => {
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "My Test Listing",
        thankYouUrl: "https://example.com/thanks",
      });

      expect(listing.id).toBe(1);
      expect(listing.name).toBe("My Test Listing");
      expect(listing.slug).toBeDefined();
      expect(listing.max_attendees).toBe(100);
      expect(listing.thank_you_url).toBe("https://example.com/thanks");
      expect(listing.created).toBeDefined();
      expect(listing.unit_price).toBe(0);
    });

    test("createListing creates listing with unit_price", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 1000,
      });

      expect(listing.unit_price).toBe(1000);
    });

    test("createListing stores and retrieves description", async () => {
      const listing = await createTestListing({
        description: "A test description",
        maxAttendees: 50,
      });

      expect(listing.description).toBe("A test description");
    });

    test("createListing defaults description to empty string", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
      });

      expect(listing.description).toBe("");
    });

    test("getAllListings returns empty array when no listings", async () => {
      const listings = await getAllListings();
      expect(listings).toEqual([]);
    });

    test("getAllListings returns listings with attendee count", async () => {
      await createTestListing({
        maxAttendees: 50,
        name: "Listing One",
        thankYouUrl: "https://example.com",
      });
      await createTestListing({
        maxAttendees: 100,
        name: "Listing Two",
        thankYouUrl: "https://example.com",
      });

      const listings = await getAllListings();
      expect(listings.length).toBe(2);
      expect(listings[0]?.attendee_count).toBe(0);
      expect(listings[1]?.attendee_count).toBe(0);
    });

    test("getListing returns null for missing listing", async () => {
      const listing = await getListing(999);
      expect(listing).toBeNull();
    });

    test("getListing returns listing by id", async () => {
      const created = await createTestListing({
        maxAttendees: 50,
        name: "Fetch Test",
        thankYouUrl: "https://example.com",
      });
      const fetched = await getListing(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("Fetch Test");
    });

    test("getListingWithCount returns null for missing listing", async () => {
      const listing = await getListingWithCount(999);
      expect(listing).toBeNull();
    });

    test("getListingWithCount returns listing with count", async () => {
      const created = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const fetched = await getListingWithCount(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.attendee_count).toBe(0);
    });

    test("getListingWithCount reflects added attendees", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Alice",
        "a@example.com",
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Bob",
        "b@example.com",
      );

      const fetched = await getListingWithCount(listing.id);
      expect(fetched?.attendee_count).toBe(2);
    });

    test("getAllListings reflects added attendees per listing", async () => {
      const listing1 = await createTestListing({ maxAttendees: 50 });
      const listing2 = await createTestListing({ maxAttendees: 50 });

      await createTestAttendee(
        listing1.id,
        listing1.slug,
        "A",
        "a@example.com",
      );
      await createTestAttendee(
        listing1.id,
        listing1.slug,
        "B",
        "b@example.com",
      );
      await createTestAttendee(
        listing2.id,
        listing2.slug,
        "C",
        "c@example.com",
      );

      const listings = await getAllListings();
      const byId = new Map(listings.map((e) => [e.id, e.attendee_count]));
      expect(byId.get(listing1.id)).toBe(2);
      expect(byId.get(listing2.id)).toBe(1);
    });

    test("listingsTable.update updates listing properties", async () => {
      const created = await createTestListing({
        maxAttendees: 50,
        name: "Original Listing",
        thankYouUrl: "https://example.com/original",
      });

      const updated = await listingsTable.update(created.id, {
        maxAttendees: 100,
        name: "Updated Listing",
        slug: created.slug,
        slugIndex: created.slug_index,
        thankYouUrl: "https://example.com/updated",
        unitPrice: 1500,
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe("Updated Listing");
      expect(updated?.max_attendees).toBe(100);
      expect(updated?.thank_you_url).toBe("https://example.com/updated");
      expect(updated?.unit_price).toBe(1500);
    });

    test("listingsTable.update returns null for non-existent listing", async () => {
      const result = await listingsTable.update(999, {
        maxAttendees: 50,
        name: "Non Existent",
        slug: "non-existent",
        slugIndex: "non-existent",
        thankYouUrl: "https://example.com",
      });
      expect(result).toBeNull();
    });

    test("listingsTable.update can set unit_price to zero", async () => {
      const created = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      const updated = await listingsTable.update(created.id, {
        maxAttendees: 50,
        name: created.name,
        slug: created.slug,
        slugIndex: created.slug_index,
        thankYouUrl: "https://example.com",
        unitPrice: 0,
      });

      expect(updated?.unit_price).toBe(0);
    });
  });

  describe("deleteListing", () => {
    test("removes listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await deleteListing(listing.id);

      const fetched = await getListing(listing.id);
      expect(fetched).toBeNull();
    });

    test("removes all attendees for the listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "John",
        "john@example.com",
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Jane",
        "jane@example.com",
      );

      await deleteListing(listing.id);

      const privateKey = await getTestPrivateKey();
      const raw = await getAttendeesRaw(listing.id);
      const attendees = await decryptAttendees(raw, privateKey);
      expect(attendees).toEqual([]);
    });

    test("keeps the processed payment of an orphaned attendee", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );

      await reserveSession("sess_listing_delete");
      await finalizePaymentSession("sess_listing_delete", attendee.id);

      await deleteListing(listing.id);

      // The attendee is orphaned, not purged, so its payment record survives.
      const processed = await isSessionProcessed("sess_listing_delete");
      expect(processed?.attendee_id).toBe(attendee.id);
    });

    test("removes activity log entries for the listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await logActivity("Action for listing", listing.id);
      await logActivity("Another action", listing.id);
      await logActivity("Global action");

      await deleteListing(listing.id);

      const listingLog = await getListingActivityLog(listing.id);
      expect(listingLog).toEqual([]);

      const allLog = await withTestSession(() => getAllActivityLog());
      const messages = allLog.map((e) => e.message);
      expect(messages).not.toContain("Action for listing");
      expect(messages).not.toContain("Another action");
      expect(messages).toContain("Global action");
    });

    test("works with no attendees", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      await deleteListing(listing.id);

      const fetched = await getListing(listing.id);
      expect(fetched).toBeNull();
    });

    // Book one attendee onto two listings, with distinct quantities so an
    // untouched booking is provable by its own value. Returns both listings and
    // the (shared) attendee id.
    const bookAttendeeOnTwoListings = async () => {
      const listing1 = await createTestListing({ maxAttendees: 50 });
      const listing2 = await createTestListing({ maxAttendees: 50 });
      const result = await createAttendeeAtomic({
        bookings: [
          { listingId: listing1.id, quantity: 2 },
          { listingId: listing2.id, quantity: 3 },
        ],
        email: "multi@example.com",
        name: "Multi",
      });
      if (!result.success) throw new Error("failed to set up test attendee");
      return { attendeeId: result.attendees[0]!.id, listing1, listing2 };
    };

    test("preserves attendees linked to other listings", async () => {
      const { attendeeId, listing1, listing2 } =
        await bookAttendeeOnTwoListings();

      await deleteListing(listing1.id);

      // The deleted listing's booking link is gone …
      expect(await getAttendeesRaw(listing1.id)).toEqual([]);
      // … while the other listing keeps the same attendee, with its own
      // booking quantity (3) untouched.
      const remaining = await getAttendeesRaw(listing2.id);
      expect(remaining.length).toBe(1);
      expect(remaining[0]!.id).toBe(attendeeId);
      expect(remaining[0]!.quantity).toBe(3);
    });

    test("keeps the shared attendee's answers when one listing is deleted", async () => {
      const { attendeeId, listing1 } = await bookAttendeeOnTwoListings();
      const question = await questionsTable.insert({
        displayType: "radio",
        text: "Meal choice?",
      });
      const answer = await answersTable.insert({
        questionId: question.id,
        sortOrder: 0,
        text: "Vegan",
      });
      await saveAttendeeAnswers(new Map([[attendeeId, [answer.id]]]));

      await deleteListing(listing1.id);

      const answers = await getAttendeeAnswersBatch([attendeeId], {
        texts: false,
      });
      expect(answers.get(attendeeId)).toEqual([answer.id]);
    });

    test("removes the deleted listing's question assignments, keeping other listings'", async () => {
      const listing1 = await createTestListing({ maxAttendees: 50 });
      const listing2 = await createTestListing({ maxAttendees: 50 });
      const question = await questionsTable.insert({
        displayType: "radio",
        text: "Meal choice?",
      });
      await setListingQuestions(listing1.id, [question.id]);
      await setListingQuestions(listing2.id, [question.id]);

      await deleteListing(listing1.id);

      // Only the deleted listing's assignment is removed; listing2 keeps its
      // own. Leaving it behind would orphan the row (and, on databases migrated
      // from the legacy schema, the listing_questions → listings FK would have
      // blocked the delete entirely).
      const rows = await queryAll<{ listing_id: number }>(
        "SELECT listing_id FROM listing_questions ORDER BY listing_id",
      );
      expect(rows.map((r) => r.listing_id)).toEqual([listing2.id]);
    });

    test("keeps the shared attendee's processed payment when one listing is deleted", async () => {
      const { attendeeId, listing1 } = await bookAttendeeOnTwoListings();
      await reserveSession("sess_multi_listing");
      await finalizePaymentSession("sess_multi_listing", attendeeId);

      await deleteListing(listing1.id);

      const processed = await isSessionProcessed("sess_multi_listing");
      expect(processed?.attendee_id).toBe(attendeeId);
    });

    test("leaves an attendee orphaned rather than deleting it", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Solo",
        "solo@example.com",
      );

      await deleteListing(listing.id);

      // The listing no longer lists the attendee …
      expect(await getAttendeesRaw(listing.id)).toEqual([]);
      // … but the attendee row itself survives with no listing link (orphaned),
      // which getAttendeeRaw surfaces as listing_id 0.
      const orphan = await getAttendeeRaw(attendee.id);
      expect(orphan).not.toBeNull();
      expect(orphan!.id).toBe(attendee.id);
      expect(orphan!.listing_id).toBe(0);
    });

    test("invalidates cache", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });

      const before = await getListing(listing.id);
      expect(before).not.toBeNull();

      await listingsTable.deleteById(listing.id);

      const after = await getListing(listing.id);
      expect(after).toBeNull();
    });
  });

  describe("slug", () => {
    test("isSlugTaken with excludeListingId excludes that listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Slug Taken Test",
        thankYouUrl: "https://example.com",
      });

      const taken = await isSlugTaken(listing.slug);
      expect(taken).toBe(true);

      const notTaken = await isSlugTaken(listing.slug, listing.id);
      expect(notTaken).toBe(false);
    });
  });

  describe("batch queries", () => {
    test("getListingWithAttendeesRaw returns listing with attendees", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Alice",
        "alice@example.com",
      );

      const result = await getListingWithAttendeesRaw(listing.id);
      expect(result).not.toBeNull();
      expect(result?.listing.id).toBe(listing.id);
      expect(result?.listing.attendee_count).toBe(1);
      expect(result?.attendeesRaw.length).toBe(1);
    });

    test("getListingWithAttendeesRaw returns null for non-existent listing", async () => {
      const result = await getListingWithAttendeesRaw(999);
      expect(result).toBeNull();
    });

    test("getListingWithAttendeeRaw returns listing with count fallback", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Bob",
        "bob@example.com",
      );

      const result = await getListingWithAttendeeRaw(listing.id, attendee.id);
      expect(result).not.toBeNull();
      expect(result?.listing.id).toBe(listing.id);
      expect(result?.attendeeRaw).not.toBeNull();
      expect(result?.listing.attendee_count).toBe(1);
    });

    test("getListingWithAttendeeRaw returns null for non-existent listing", async () => {
      const result = await getListingWithAttendeeRaw(999, 1);
      expect(result).toBeNull();
    });

    // Regression: these loaders SELECT the listing row directly (not via
    // LISTING_COUNT_SELECT), and income is now projected from the ledger rather
    // than read off a `listings.income` column. Dropping that column without
    // adding the projection to these queries left `income` undefined, so
    // decryptListingWithCount's Number(undefined) produced NaN. Both must report
    // the real ledger income.
    test("getListingWithAttendeesRaw projects ledger income (never NaN)", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada",
        "ada@example.com",
      );
      await postListingSale({
        attendeeId: attendee.id,
        gross: 2500,
        listingId: listing.id,
      });

      const result = await getListingWithAttendeesRaw(listing.id);
      expect(Number.isNaN(result?.listing.income)).toBe(false);
      expect(result?.listing.income).toBe(2500);
    });

    test("getListingWithAttendeeRaw projects ledger income (never NaN)", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Grace",
        "grace@example.com",
      );
      await postListingSale({
        attendeeId: attendee.id,
        gross: 1800,
        listingId: listing.id,
      });

      const result = await getListingWithAttendeeRaw(listing.id, attendee.id);
      expect(Number.isNaN(result?.listing.income)).toBe(false);
      expect(result?.listing.income).toBe(1800);
    });

    test("getListingsBySlugsBatch returns empty array for empty slugs", async () => {
      const result = await getListingsBySlugsBatch([]);
      expect(result).toEqual([]);
    });

    test("getListingsBySlugsBatch returns listings in slug order", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 10,
        name: "Batch A",
        thankYouUrl: "https://example.com",
      });
      const listing2 = await createTestListing({
        maxAttendees: 20,
        name: "Batch B",
        thankYouUrl: "https://example.com",
      });

      const results = await getListingsBySlugsBatch([
        listing2.slug,
        listing1.slug,
      ]);
      expect(results.length).toBe(2);
      expect(results[0]?.id).toBe(listing2.id);
      expect(results[1]?.id).toBe(listing1.id);
    });

    test("getListingsBySlugsBatch returns null for missing slugs", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        name: "Exists",
        thankYouUrl: "https://example.com",
      });

      const results = await getListingsBySlugsBatch([listing.slug, "missing"]);
      expect(results.length).toBe(2);
      expect(results[0]).not.toBeNull();
      expect(results[1]).toBeNull();
    });
  });

  describe("writeClosesAt", () => {
    test("encrypts empty string for no deadline", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const result = await writeClosesAt("");
      expect(typeof result).toBe("string");
      expect(result).not.toBe("");
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe("");
    });

    test("encrypts null as empty string", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const result = await writeClosesAt(null);
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe("");
    });

    test("normalizes datetime-local string without timezone as UTC", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const input = "2099-06-15T14:30";
      const result = await writeClosesAt(input);
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe(new Date(`${input}Z`).toISOString());
    });

    test("handles already-normalized ISO string", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const result = await writeClosesAt("2099-06-15T14:30:00.000Z");
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe("2099-06-15T14:30:00.000Z");
    });

    test("normalizes timezone offset to UTC", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const input = "2099-06-15T14:30:00-05:00";
      const result = await writeClosesAt(input);
      const decrypted = await decrypt(result as unknown as string);
      expect(decrypted).toBe(new Date(input).toISOString());
    });
  });

  describe("writeListingDate", () => {
    test("encrypts empty string for no date", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const result = await writeListingDate("");
      expect(typeof result).toBe("string");
      expect(result).not.toBe("");
      const decrypted = await decrypt(result);
      expect(decrypted).toBe("");
    });

    test("normalizes datetime-local string without timezone as UTC", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const input = "2026-06-15T14:00";
      const result = await writeListingDate(input);
      const decrypted = await decrypt(result);
      expect(decrypted).toBe(new Date(`${input}Z`).toISOString());
    });

    test("handles already-normalized ISO string", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const result = await writeListingDate("2026-06-15T14:00:00.000Z");
      const decrypted = await decrypt(result);
      expect(decrypted).toBe("2026-06-15T14:00:00.000Z");
    });

    test("normalizes timezone offset to UTC", async () => {
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const input = "2026-06-15T14:00:00+02:00";
      const result = await writeListingDate(input);
      const decrypted = await decrypt(result);
      expect(decrypted).toBe(new Date(input).toISOString());
    });

    test("returns empty string for invalid datetime", async () => {
      const errorSpy = spy(console, "error");
      const { decrypt } = await import("#shared/crypto/encryption.ts");
      const result = await writeListingDate("not-a-dateZ");
      const decrypted = await decrypt(result);
      expect(decrypted).toBe("");
      expect(errorSpy.calls.length).toBeGreaterThan(0);
      errorSpy.restore();
    });
  });

  describe("listing date read transform", () => {
    test("returns empty string for no-date listing", async () => {
      const listing = await listingsTable.insert({
        date: "",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-date-read-1",
        slugIndex: await computeSlugIndex("test-date-read-1"),
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.date).toBe("");
    });

    test("returns normalized ISO string for valid datetime", async () => {
      const listing = await listingsTable.insert({
        date: "2026-06-15T14:00",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-date-read-2",
        slugIndex: await computeSlugIndex("test-date-read-2"),
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.date).toBe("2026-06-15T14:00:00.000Z");
    });
  });

  describe("closes_at read transform", () => {
    test("returns null for no-deadline listing", async () => {
      const listing = await listingsTable.insert({
        closesAt: "",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-read-1",
        slugIndex: await computeSlugIndex("test-read-1"),
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.closes_at).toBeNull();
    });

    test("returns normalized ISO string for valid datetime", async () => {
      const listing = await listingsTable.insert({
        closesAt: "2099-12-31T23:59",
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test",
        slug: "test-read-2",
        slugIndex: await computeSlugIndex("test-read-2"),
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.closes_at).toBe("2099-12-31T23:59:00.000Z");
    });
  });

  describe("duration_days write clamp", () => {
    const insertWithDuration = async (slug: string, durationDays: number) => {
      const listing = await listingsTable.insert({
        durationDays,
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-duration",
        slug,
        slugIndex: await computeSlugIndex(slug),
      });
      return (await getListingWithCount(listing.id))!.duration_days;
    };

    test(`clamps values above MAX_DURATION_DAYS down to ${MAX_DURATION_DAYS}`, async () => {
      expect(await insertWithDuration("test-dur-high", 500)).toBe(
        MAX_DURATION_DAYS,
      );
    });

    test("clamps zero to 1", async () => {
      expect(await insertWithDuration("test-dur-zero", 0)).toBe(1);
    });

    test("clamps negative values to 1", async () => {
      expect(await insertWithDuration("test-dur-neg", -3)).toBe(1);
    });

    test("floors fractional values to whole days", async () => {
      expect(await insertWithDuration("test-dur-frac", 2.7)).toBe(2);
    });

    test("degrades non-finite values to the 1-day default", async () => {
      expect(await insertWithDuration("test-dur-nan", Number.NaN)).toBe(1);
    });

    test("clamps on update as well as insert", async () => {
      const listing = await listingsTable.insert({
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-duration",
        slug: "test-dur-upd",
        slugIndex: await computeSlugIndex("test-dur-upd"),
      });
      await listingsTable.update(listing.id, { durationDays: 1000 });
      expect((await getListingWithCount(listing.id))!.duration_days).toBe(
        MAX_DURATION_DAYS,
      );
    });
  });

  describe("bookable_days read transform", () => {
    test("returns empty array when DB contains non-array JSON", async () => {
      const listing = await listingsTable.insert({
        maxAttendees: 100,
        maxPrice: 10000,
        name: "test-bd",
        slug: "test-bd-1",
        slugIndex: await computeSlugIndex("test-bd-1"),
      });
      await getDb().execute({
        args: ['"not-an-array"', listing.id],
        sql: "UPDATE listings SET bookable_days = ? WHERE id = ?",
      });
      const saved = await getListingWithCount(listing.id);
      expect(saved?.bookable_days).toEqual([]);
    });
  });

  describe("bounded name lookups", () => {
    test("getListingNamesByIds returns decrypted names only for the given ids", async () => {
      const alpha = await createTestListing({
        maxAttendees: 10,
        name: "Alpha",
      });
      const beta = await createTestListing({ maxAttendees: 10, name: "Beta" });

      const names = await getListingNamesByIds([alpha.id]);

      expect(names.get(alpha.id)).toBe("Alpha");
      expect(names.has(beta.id)).toBe(false);
    });

    test("getListingNamesByIds returns an empty map for no ids", async () => {
      const names = await getListingNamesByIds([]);
      expect(names.size).toBe(0);
    });

    test("getAttendeeNamesByIds decrypts the name for the given attendee id", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Grace Hopper",
        "grace@example.com",
      );

      const privateKey = await getTestPrivateKey();
      const names = await getAttendeeNamesByIds([attendee.id], privateKey);

      expect(names.get(attendee.id)).toBe("Grace Hopper");
    });

    test("getAttendeeNamesByIds returns an empty map for no ids", async () => {
      const privateKey = await getTestPrivateKey();
      const names = await getAttendeeNamesByIds([], privateKey);
      expect(names.size).toBe(0);
    });
  });

  describe("listingRevenueBreakdown", () => {
    /** Read the listing's income exactly as the page projects it — the
     * `creditsLessWriteoffDebits` subquery behind `listingIncomeSubquery` — so the
     * reconciliation invariant is asserted against the SAME projection, not a
     * re-derivation. */
    const projectedIncome = async (listingId: number): Promise<number> => {
      // listingIncomeSubquery interpolates its id expression four times (the
      // credited/written-off predicates each appear in the CASE and the WHERE).
      // Ledger ids are TEXT, so the id is bound as a string (a numeric bind casts
      // to "1.0" and matches nothing); the outer `id = ?` still matches by the
      // listings column's INTEGER affinity.
      const row = (await queryOne<{ income: number | bigint }>(
        `SELECT ${listingIncomeSubquery("?")} FROM listings WHERE id = ?`,
        Array(5).fill(String(listingId)),
      ))!;
      return Number(row.income);
    };

    test("derives gross sales, a manual write-down, and refunds, and reconciles", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const buyer = await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada",
        "ada@example.com",
      );
      // Two gross sales credit revenue:id.
      await postListingSale({
        attendeeId: buyer.id,
        eventId: "sale-a",
        gross: 5000,
        listingId: listing.id,
      });
      await postListingSale({
        attendeeId: buyer.id,
        eventId: "sale-b",
        gross: 3000,
        listingId: listing.id,
      });
      // A manual write-DOWN (decision 14): revenue:id → writeoff, lowering income.
      await postWriteoffAdjustment(revenueAccount(listing.id), -1000, [
        "income-adjust",
        listing.id,
      ]);
      // A refund debits revenue:id (revenue → attendee) without touching income.
      await postAttendeeRefund({
        attendeeId: buyer.id,
        gross: 2000,
        listingId: listing.id,
      });

      const breakdown = await listingRevenueBreakdown(listing.id);
      // The refund also posts its own net-zero sale leg first, so gross is 10000.
      expect(breakdown.grossSales).toBe(10000);
      expect(breakdown.manualAdjustments).toBe(-1000);
      expect(breakdown.recognisedIncome).toBe(9000);
      expect(breakdown.refunds).toBe(2000);
      expect(breakdown.netBalance).toBe(7000);

      // Reconciliation invariants: recognised income equals the existing income
      // projection, and the net balance equals the raw account balance.
      expect(breakdown.recognisedIncome).toBe(
        await projectedIncome(listing.id),
      );
      expect(breakdown.netBalance).toBe(
        await accountBalance(revenueAccount(listing.id)),
      );
      // The breakdown reconciles on its own face, too.
      expect(breakdown.recognisedIncome).toBe(
        breakdown.grossSales + breakdown.manualAdjustments,
      );
      expect(breakdown.netBalance).toBe(
        breakdown.recognisedIncome - breakdown.refunds,
      );
    });

    test("counts a manual write-up as a positive adjustment", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const buyer = await createTestAttendee(
        listing.id,
        listing.slug,
        "Grace",
        "grace@example.com",
      );
      await postListingSale({
        attendeeId: buyer.id,
        gross: 4000,
        listingId: listing.id,
      });
      // A manual write-UP: writeoff → revenue:id, raising income.
      await postWriteoffAdjustment(revenueAccount(listing.id), 1500, [
        "income-adjust",
        listing.id,
      ]);

      const breakdown = await listingRevenueBreakdown(listing.id);
      expect(breakdown.grossSales).toBe(4000);
      expect(breakdown.manualAdjustments).toBe(1500);
      expect(breakdown.recognisedIncome).toBe(5500);
      expect(breakdown.refunds).toBe(0);
      expect(breakdown.netBalance).toBe(5500);
      expect(breakdown.recognisedIncome).toBe(
        await projectedIncome(listing.id),
      );
      expect(breakdown.netBalance).toBe(
        await accountBalance(revenueAccount(listing.id)),
      );
    });

    test("is all-zero for a listing with no ledger activity", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const breakdown = await listingRevenueBreakdown(listing.id);
      expect(breakdown).toEqual({
        grossSales: 0,
        manualAdjustments: 0,
        netBalance: 0,
        recognisedIncome: 0,
        refunds: 0,
      });
      expect(breakdown.recognisedIncome).toBe(
        await projectedIncome(listing.id),
      );
      expect(breakdown.netBalance).toBe(
        await accountBalance(revenueAccount(listing.id)),
      );
    });
  });
});

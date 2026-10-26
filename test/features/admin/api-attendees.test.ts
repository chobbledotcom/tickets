import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#db/attendee-statuses.ts";
import { PENDING_NOTIFICATION } from "#db/attendees/notification-flags.ts";
import { getAttendeeRaw } from "#db/attendees/queries.ts";
import {
  assertJson,
  expectListingActivityLogContains,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  attendeeExists,
  readPendingNotificationFlags,
  stubRefusedAtomicCreate,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { apiRequest } from "#test-utils/session.ts";

/** One POST create request carrying the minimal valid body for a listing. */
const createBooking = (
  listingId: number,
  body: Record<string, unknown> = {},
): Promise<Response> =>
  apiRequest("/api/admin/attendees", {
    body: {
      email: "ada@example.com",
      lines: [{ listingId, quantity: 1 }],
      name: "Ada Lovelace",
      ...body,
    },
    method: "POST",
  });

/** The roster endpoint decrypts and answers every booking on the listing. */
const rosterAttendeeIds = async (listingId: number): Promise<number[]> => {
  const roster = await assertJson(
    apiRequest(`/api/admin/listings/${listingId}/attendees`),
    200,
  );
  return roster.attendees.map((attendee: { id: number }) => attendee.id);
};

describeWithEnv("Admin API - POST /api/admin/attendees", { db: true }, () => {
  test("creates a booking whose PII is encrypted at rest and reads back", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Falcon Fair",
      unitPrice: 500,
    });

    const created = await assertJson(
      createBooking(listing.id, {
        address: "1 Fair Lane",
        phone: "01234 567890",
        special_instructions: "Late arrival",
      }),
      201,
      (body) => {
        expect(body.attendee).toMatchObject({
          address: "1 Fair Lane",
          email: "ada@example.com",
          listing_id: listing.id,
          name: "Ada Lovelace",
          phone: "01234 567890",
          quantity: 1,
          special_instructions: "Late arrival",
        });
        expect(body.attendee.id).toBeGreaterThan(0);
        // The answer never leaks the sealed blob or its blind index.
        expect(body.attendee.pii_blob).toBeUndefined();
        expect(body.attendee.ticket_token_index).toBeUndefined();
      },
    );
    const attendeeId = created.attendee.id as number;
    expect(await attendeeExists(attendeeId)).toBe(true);

    // At rest the PII is ciphertext, never the plaintext name.
    const stored = await getAttendeeRaw(attendeeId);
    expect(stored).not.toBeNull();
    expect(stored!.pii_blob).not.toContain("Ada Lovelace");

    // The admin roster endpoint decrypts the booking back.
    expect(await rosterAttendeeIds(listing.id)).toContain(attendeeId);
    await expectListingActivityLogContains(listing.id, "added via API");
  });

  test("never sends the buyer email; the owed-email flag matches a manual add", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Email Fair",
      unitPrice: 400,
    });
    const created = await assertJson(
      createBooking(listing.id, { email: "buyer@example.com" }),
      201,
    );
    const flags = await readPendingNotificationFlags(created.attendee.id);
    // The flag stays UP as "added by an admin": the email is owed, not sent.
    expect(flags.email).toBe(PENDING_NOTIFICATION.admin);
    expect(flags.webhooks).toBe(PENDING_NOTIFICATION.none);
  });

  test("a booking on a listing that collects no email owes no email", async () => {
    const listing = await createTestListing({
      fields: "",
      maxAttendees: 10,
      name: "No Email Fair",
    });
    const created = await assertJson(createBooking(listing.id), 201);
    const flags = await readPendingNotificationFlags(created.attendee.id);
    expect(flags.email).toBe(PENDING_NOTIFICATION.none);
  });

  test("a retry with the same ticketToken returns the same booking without duplicating", async () => {
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Idempotent Fair",
    });
    const body = {
      email: "again@example.com",
      lines: [{ listingId: listing.id, quantity: 1 }],
      name: "Retry Person",
      ticketToken: "stable-token-1",
    };
    const first = await assertJson(
      apiRequest("/api/admin/attendees", { body, method: "POST" }),
      201,
    );
    const retried = await assertJson(
      apiRequest("/api/admin/attendees", { body, method: "POST" }),
      200,
    );
    expect(retried.attendee.id).toBe(first.attendee.id);

    const fresh = await assertJson(
      apiRequest("/api/admin/attendees", {
        body: { ...body, ticketToken: "stable-token-2" },
        method: "POST",
      }),
      201,
    );
    expect(fresh.attendee.id).not.toBe(first.attendee.id);
    expect(await rosterAttendeeIds(listing.id)).toHaveLength(2);
  });

  test("a body with no lines fails with a 400", async () => {
    const listing = await createTestListing({ name: "Empty Fair" });
    await assertJson(createBooking(listing.id, { lines: [] }), 400, (body) =>
      expect(body.error).toBe("Add at least one booking line"),
    );
  });

  test("resolves status by name and refuses an unknown status", async () => {
    const listing = await createTestListing({ name: "Status Fair" });
    const vip = await attendeeStatuses.table.insert({ name: "VIP" });
    const created = await assertJson(
      createBooking(listing.id, { name: "VIP Buyer", status: "VIP" }),
      201,
    );
    expect(created.attendee.status_id).toBe(vip.id);
    await assertJson(
      createBooking(listing.id, { name: "Lost", status: "No such status" }),
      400,
      (body) => expect(body.error).toBe("Unknown status 'No such status'"),
    );
  });

  test("refuses an unknown listing, an undated daily booking, and a missing name", async () => {
    await assertJson(createBooking(99999, { name: "Lost" }), 400, (body) =>
      expect(body.error).toBe("lines[0] references an unknown listing"),
    );

    const daily = await createTestListing({
      listingType: "daily",
      maxAttendees: 10,
      name: "Daily Fair",
    });
    await assertJson(
      createBooking(daily.id, { name: "Undated" }),
      400,
      (body) =>
        expect(body.error).toBe(
          "lines[0].date must be a booking day as YYYY-MM-DD",
        ),
    );

    await assertJson(
      apiRequest("/api/admin/attendees", {
        body: {
          lines: [{ date: "2026-08-14", listingId: daily.id, quantity: 1 }],
        },
        method: "POST",
      }),
      400,
      (body) => expect(body.error).toBe("name is required"),
    );
  });

  test("an API-created booking may overbook, like a manual admin add", async () => {
    const listing = await createTestListing({
      maxAttendees: 1,
      maxQuantity: 2,
      name: "Overbook Fair",
    });
    await assertJson(
      createBooking(listing.id, {
        lines: [{ listingId: listing.id, quantity: 2 }],
        name: "Overbooker",
      }),
      201,
    );
  });

  test("books a daily listing on its date, with and without a day count", async () => {
    const listing = await createTestListing({
      listingType: "daily",
      maxAttendees: 10,
      name: "Dated Fair",
    });
    await assertJson(
      createBooking(listing.id, {
        lines: [
          {
            date: "2026-08-14",
            durationDays: 2,
            listingId: listing.id,
            quantity: 1,
          },
        ],
      }),
      201,
      (body) => {
        expect(body.attendee).toMatchObject({
          date: "2026-08-14",
          listing_id: listing.id,
          quantity: 1,
        });
      },
    );
    // A daily booking without a day count defaults to one day.
    await assertJson(
      createBooking(listing.id, {
        lines: [{ date: "2026-08-15", listingId: listing.id, quantity: 1 }],
        name: "Single Day",
      }),
      201,
      (body) => expect(body.attendee.date).toBe("2026-08-15"),
    );
  });

  test("refuses two lines that book the same slot", async () => {
    const listing = await createTestListing({ name: "Dup Fair" });
    await assertJson(
      createBooking(listing.id, {
        lines: [
          { listingId: listing.id, quantity: 1 },
          { listingId: listing.id, quantity: 1 },
        ],
      }),
      400,
      (body) => expect(body.error).toBe("Two lines book the same slot"),
    );
  });

  describe("refuses a malformed body", () => {
    test("contact fields that are not text or fail their format", async () => {
      const listing = await createTestListing({ name: "Bad Contact Fair" });
      for (const [body, error] of [
        [{ email: 5 }, "email must be text"],
        [{ email: "not-an-email" }, "Please enter a valid email address"],
        [{ phone: 5 }, "phone must be text"],
        [{ phone: "not-a-phone" }, "Please enter a valid phone number"],
        [{ address: 5 }, "address must be text"],
        [{ special_instructions: 5 }, "special_instructions must be text"],
        [
          { address: "x".repeat(251) },
          "Address must be 250 characters or fewer",
        ],
        [
          { special_instructions: "x".repeat(251) },
          "Special instructions must be 250 characters or fewer",
        ],
      ] as const) {
        await assertJson(createBooking(listing.id, body), 400, (parsed) =>
          expect(parsed.error).toBe(error),
        );
      }
      await assertJson(
        createBooking(listing.id, { name: "x".repeat(251) }),
        400,
        (parsed) =>
          expect(parsed.error).toBe("Name must be 250 characters or fewer"),
      );
    });

    test("lines that miss a listing, a whole quantity, or a daily date", async () => {
      const listing = await createTestListing({ name: "Bad Line Fair" });
      await assertJson(
        createBooking(listing.id, {
          lines: [{ listingId: 99999, quantity: 1 }],
        }),
        400,
        (parsed) =>
          expect(parsed.error).toBe("lines[0] references an unknown listing"),
      );
      await assertJson(
        createBooking(listing.id, { lines: [{ listingId: listing.id }] }),
        400,
        (parsed) =>
          expect(parsed.error).toBe(
            "lines[0] needs a positive listingId and quantity, and a whole durationDays from 1 to 90",
          ),
      );
      const tight = await createTestListing({
        maxQuantity: 1,
        name: "Tight Fair",
      });
      await assertJson(
        createBooking(tight.id, {
          lines: [{ listingId: tight.id, quantity: 2 }],
        }),
        400,
        (parsed) =>
          expect(parsed.error).toBe(
            "lines[0].quantity is more than the listing allows",
          ),
      );
    });

    test("a daily listing needs a real booking day; a standard one takes none", async () => {
      const daily = await createTestListing({
        listingType: "daily",
        maxAttendees: 10,
        name: "Dated Fair",
      });
      await assertJson(
        createBooking(daily.id, {
          lines: [{ date: "not-a-day", listingId: daily.id, quantity: 1 }],
        }),
        400,
        (parsed) =>
          expect(parsed.error).toBe(
            "lines[0].date must be a booking day as YYYY-MM-DD",
          ),
      );
      const standard = await createTestListing({ name: "Undated Fair" });
      await assertJson(
        createBooking(standard.id, {
          lines: [{ date: "2026-08-14", listingId: standard.id, quantity: 1 }],
        }),
        400,
        (parsed) =>
          expect(parsed.error).toBe(
            "lines[0].date only applies to daily listings",
          ),
      );
      await assertJson(
        createBooking(standard.id, {
          lines: [{ durationDays: 2, listingId: standard.id, quantity: 1 }],
        }),
        400,
        (parsed) =>
          expect(parsed.error).toBe(
            "lines[0].durationDays only applies to daily listings",
          ),
      );
    });

    test("a missing or malformed lines array, status, or retry token", async () => {
      const listing = await createTestListing({ name: "Bad Shape Fair" });
      for (const [body, error] of [
        [{ name: "No lines" }, "lines is required"],
        [{ lines: "nope", name: "Bad lines" }, "lines must be an array"],
        [
          {
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "St",
            status: 5,
          },
          "status must be text",
        ],
        [
          {
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Tok",
            ticketToken: "",
          },
          "ticketToken must be non-empty text",
        ],
      ] as const) {
        await assertJson(
          apiRequest("/api/admin/attendees", { body, method: "POST" }),
          400,
          (parsed) => expect(parsed.error).toBe(error),
        );
      }
    });

    test("answers 400 when the atomic create refuses", async () => {
      const listing = await createTestListing({ name: "Refused Fair" });
      await withMocks(stubRefusedAtomicCreate, async () => {
        await assertJson(
          createBooking(listing.id, { name: "Refused" }),
          400,
          (parsed) =>
            expect(parsed.error).toBe("The booking could not be created"),
        );
      });
    });
  });
});

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createBooking,
  stubRefusedAtomicCreate,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv(
  "Admin API - POST /api/admin/attendees refuses a malformed body",
  { db: true },
  () => {
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
      // An empty name is the same refusal as a missing one: the row never
      // stores a nameless booking.
      await assertJson(createBooking(listing.id, { name: "" }), 400, (body) =>
        expect(body.error).toBe("name is required"),
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
      await assertJson(
        createBooking(listing.id, { lines: [{ listingId: 0, quantity: 1 }] }),
        400,
        (parsed) =>
          expect(parsed.error).toBe(
            "lines[0] needs a positive listingId and quantity, and a whole durationDays from 1 to 90",
          ),
      );
      await assertJson(
        createBooking(listing.id, {
          lines: [{ listingId: listing.id, quantity: 0 }],
        }),
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
            name: "Blank status",
            status: "",
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
  },
);

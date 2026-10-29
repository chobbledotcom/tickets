import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingQuestions } from "#db/questions/queries.ts";
import {
  addAnswer,
  assignQuestion,
  createQuestion,
} from "#test/shared/db/questions/helpers.ts";
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
            adjustments: [{ amount: 0, description: "Zero" }],
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Zero adjust",
          },
          "adjustments[0].amount must be a whole number of pence or cents, not zero",
        ],
        [
          {
            adjustments: [{ amount: 100, description: "" }],
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Blank adjust",
          },
          "adjustments[0].description must be text",
        ],
        [
          {
            adjustments: [5],
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Shape adjust",
          },
          "adjustments[0] must name a description and an amount",
        ],
        [
          {
            adjustments: [{ amount: 100, description: "x".repeat(201) }],
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Long adjust",
          },
          "adjustments[0].description must be 200 characters or fewer",
        ],
        [
          {
            adjustments: "nope",
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Bad adjust",
          },
          "adjustments must be an array",
        ],
        [
          {
            lines: [{ listingId: listing.id, price: -1, quantity: 1 }],
            name: "Bad price",
          },
          "lines[0].price must be a whole number of pence or cents from 0",
        ],
        [
          {
            lines: [{ listingId: listing.id, price: 1.5, quantity: 1 }],
            name: "Fractional price",
          },
          "lines[0].price must be a whole number of pence or cents from 0",
        ],
        [
          {
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Bad payment",
            payments: [{ amount: 0 }],
          },
          "payments[0].amount must be a positive whole number of pence or cents",
        ],
        [
          {
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Non-array payment",
            payments: 5,
          },
          "payments must be an array",
        ],
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
        [
          {
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Long token",
            ticketToken: "t".repeat(251),
          },
          "ticketToken must be 250 characters or fewer",
        ],
        [
          {
            created: "not-an-instant",
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Bad created",
          },
          "created must be a valid instant as 2026-09-01T09:00:00Z",
        ],
        [
          {
            created: "",
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Blank created",
          },
          "created must be a valid instant as 2026-09-01T09:00:00Z",
        ],
        [
          {
            created: 5,
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Numeric created",
          },
          "created must be a valid instant as 2026-09-01T09:00:00Z",
        ],
        [
          {
            // Temporal rejects a calendar-impossible day that Date.parse
            // would silently roll over, so the malformed instant is caught.
            created: "2026-02-30T09:00:00Z",
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Impossible created",
          },
          "created must be a valid instant as 2026-09-01T09:00:00Z",
        ],
      ] as const) {
        await assertJson(
          apiRequest("/api/admin/attendees", { body, method: "POST" }),
          400,
          (parsed) => expect(parsed.error).toBe(error),
        );
      }
    });

    test("answers that are malformed, ask the wrong kind, or miss the booking", async () => {
      const listing = await createTestListing({ name: "Bad Answer Fair" });
      const { answer: veggie, question: meal } = await assignQuestion(
        listing.id,
        "Meal?",
        "Veggie",
      );
      const inactive = await addAnswer(meal.id, 1, "Meat", {
        active: false,
      });
      const other = await createTestListing({ name: "Other Fair" });
      const { answer: otherAnswer, question: otherQuestion } =
        await assignQuestion(other.id, "Other?", "No");
      const freeText = await createQuestion("Allergies?", {
        displayType: "free_text",
      });
      await listingQuestions.setIds(listing.id, [meal.id, freeText.id]);

      for (const [body, error] of [
        [{ answers: 5 }, "answers must be an array"],
        [{ answers: [5] }, "answers[0] must name a question and an answer"],
        [
          { answers: [{ answerId: veggie.id }] },
          "answers[0].questionId must be a positive whole number",
        ],
        [
          { answers: [{ answerId: veggie.id, questionId: 0 }] },
          "answers[0].questionId must be a positive whole number",
        ],
        [
          { answers: [{ answerId: veggie.id, questionId: "1" }] },
          "answers[0].questionId must be a positive whole number",
        ],
        [
          { answers: [{ answerId: veggie.id, questionId: 99999 }] },
          "answers[0] names a question this booking does not ask",
        ],
        [
          {
            answers: [
              { answerId: otherAnswer.id, questionId: otherQuestion.id },
            ],
          },
          "answers[0] names a question this booking does not ask",
        ],
        [
          { answers: [{ answerId: 0, questionId: meal.id }] },
          "answers[0].answerId is not one of the question's answers",
        ],
        [
          { answers: [{ answerId: inactive.id, questionId: meal.id }] },
          "answers[0].answerId is a deactivated answer",
        ],
        [
          { answers: [{ questionId: meal.id }] },
          "answers[0] must name an answerId or a freeText, not both",
        ],
        [
          {
            answers: [
              { answerId: veggie.id, freeText: "x", questionId: meal.id },
            ],
          },
          "answers[0] must name an answerId or a freeText, not both",
        ],
        [
          { answers: [{ answerId: veggie.id, questionId: freeText.id }] },
          "answers[0].answerId only applies to choice questions",
        ],
        [
          { answers: [{ freeText: "x", questionId: meal.id }] },
          "answers[0].freeText only applies to free-text questions",
        ],
        [
          { answers: [{ freeText: "", questionId: freeText.id }] },
          "answers[0].freeText must be non-empty text",
        ],
        [
          { answers: [{ freeText: 5, questionId: freeText.id }] },
          "answers[0].freeText must be non-empty text",
        ],
        [
          {
            answers: [{ freeText: "x".repeat(10241), questionId: freeText.id }],
          },
          "answers[0].freeText must be 10240 characters or fewer",
        ],
      ] as const) {
        await assertJson(createBooking(listing.id, body), 400, (parsed) =>
          expect(parsed.error).toBe(error),
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

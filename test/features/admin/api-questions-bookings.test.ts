/**
 * The question's booking links and answer stats: the bookings that answered a
 * question, and the selection total each answer carries.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { execute, getDb } from "#db/client.ts";
import { getAnswerSelectionTotals } from "#db/questions/aggregates.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { handleRequest } from "#routes";
import { seedChoiceAndTextQuestions } from "#test/shared/db/questions/helpers.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createBooking } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  apiRequest,
  createTestManagerSession,
  requestAsSession,
  testCsrfToken,
} from "#test-utils/session.ts";

/** One booking's id, from the create answer. */
const bookAnswer = async (
  listingId: number,
  body: Record<string, unknown> = {},
): Promise<number> =>
  (
    await assertJson<{ attendee: { id: number } }>(
      createBooking(listingId, body),
      201,
    )
  ).attendee.id;

/** Each answer's selection total, in the order the answers arrived. A write
 *  response that leaves the total out reads back as `undefined` here. */
const selectedTotals = (
  answers: { times_selected?: number }[],
): (number | undefined)[] => answers.map((answer) => answer.times_selected);

describeWithEnv(
  "Admin API - question bookings and stats",
  { db: true, triggers: true },
  () => {
    test("lists the bookings that answered a question, newest booking first", async () => {
      const { large, listing, notes, size, small } =
        await seedChoiceAndTextQuestions();
      const older = await bookAnswer(listing.id, {
        answers: [
          { answerId: large.id, questionId: size.id },
          { freeText: "Peanuts", questionId: notes.id },
        ],
        created: "2026-06-01T09:00:00Z",
      });
      const newer = await bookAnswer(listing.id, {
        answers: [{ answerId: small.id, questionId: size.id }],
        created: "2026-06-02T09:00:00Z",
      });

      await assertJson(
        apiRequest(`/api/admin/questions/${size.id}/bookings`),
        200,
        (body) => {
          expect(body.bookings).toEqual([
            {
              answer_id: small.id,
              answer_text: "Small",
              attendee_id: newer,
              created: "2026-06-02T09:00:00.000Z",
              free_text: null,
              listing_ids: [listing.id],
              question_id: size.id,
            },
            {
              answer_id: large.id,
              answer_text: "Large",
              attendee_id: older,
              created: "2026-06-01T09:00:00.000Z",
              free_text: null,
              listing_ids: [listing.id],
              question_id: size.id,
            },
          ]);
        },
      );
    });

    test("answers a free-text booking with the words the buyer typed", async () => {
      const { listing, notes, size, small } =
        await seedChoiceAndTextQuestions();
      const attendeeId = await bookAnswer(listing.id, {
        answers: [
          { answerId: small.id, questionId: size.id },
          { freeText: "Peanuts", questionId: notes.id },
        ],
        created: "2026-06-03T09:00:00Z",
      });

      await assertJson(
        apiRequest(`/api/admin/questions/${notes.id}/bookings`),
        200,
        (body) => {
          expect(body.bookings).toEqual([
            {
              answer_id: null,
              answer_text: null,
              attendee_id: attendeeId,
              created: "2026-06-03T09:00:00.000Z",
              free_text: "Peanuts",
              listing_ids: [listing.id],
              question_id: notes.id,
            },
          ]);
        },
      );
    });

    test("answers no bookings for a question nobody answered", async () => {
      const { size } = await seedChoiceAndTextQuestions();
      await assertJson(
        apiRequest(`/api/admin/questions/${size.id}/bookings`),
        200,
        (body) => {
          expect(body.bookings).toEqual([]);
        },
      );
    });

    test("carries each answer's selection total on the single and list reads", async () => {
      const { large, listing, size, small } =
        await seedChoiceAndTextQuestions();
      await bookAnswer(listing.id, {
        answers: [{ answerId: large.id, questionId: size.id }],
      });
      await bookAnswer(listing.id, {
        answers: [{ answerId: large.id, questionId: size.id }],
      });
      await bookAnswer(listing.id, {
        answers: [{ answerId: small.id, questionId: size.id }],
      });

      // The trigger-maintained totals are the count the question page shows.
      expect(await getAnswerSelectionTotals([size.id])).toEqual(
        new Map([
          [small.id, 1],
          [large.id, 2],
        ]),
      );
      await assertJson(
        apiRequest(`/api/admin/questions/${size.id}`),
        200,
        (body) => {
          expect(selectedTotals(body.question.answers)).toEqual([1, 2]);
        },
      );
      await assertJson(apiRequest("/api/admin/questions"), 200, (body) => {
        expect(selectedTotals(body.questions[0].answers)).toEqual([1, 2]);
      });
    });

    test("every write that answers with a question carries the selection totals", async () => {
      // The question update, the answer create, and the answer update all
      // answer with the whole question, so each one carries the totals its
      // answer rows store.
      const { listing, size, small } = await seedChoiceAndTextQuestions();
      await bookAnswer(listing.id, {
        answers: [{ answerId: small.id, questionId: size.id }],
      });

      await assertJson(
        apiRequest(`/api/admin/questions/${size.id}`, {
          body: { assign_all: true },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(selectedTotals(body.question.answers)).toEqual([1, 0]);
        },
      );
      const created = await assertJson<{
        question: { answers: { id: number; times_selected?: number }[] };
      }>(
        apiRequest(`/api/admin/questions/${size.id}/answers`, {
          body: { text: "Medium" },
          method: "POST",
        }),
        201,
        (body) => {
          expect(selectedTotals(body.question.answers)).toEqual([1, 0, 0]);
        },
      );
      await assertJson(
        apiRequest(
          `/api/admin/questions/${size.id}/answers/${created.question.answers[2]!.id}`,
          { body: { text: "Extra large" }, method: "PUT" },
        ),
        200,
        (body) => {
          expect(selectedTotals(body.question.answers)).toEqual([1, 0, 0]);
        },
      );
    });

    test("answers a new answer's total when a replica read misses the write", async () => {
      // A plain read can be served by a replica that has not caught up with
      // the answer the write just made. The write response reads totals from
      // the primary, so the new answer still carries its total instead of
      // failing on a missing row.
      const { large, size, small } = await seedChoiceAndTextQuestions();
      const database = getDb();
      const liveExecute = database.execute.bind(database);
      using _laggingReplica = stub(
        database,
        "execute",
        (statement: SqlStatement) => {
          const sql = statement.sql;
          return sql.includes("answer.times_selected")
            ? Promise.resolve(emptyResultSet())
            : liveExecute(statement);
        },
      );

      await assertJson(
        apiRequest(`/api/admin/questions/${size.id}/answers`, {
          body: { text: "Medium" },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.question.answers).toEqual([
            {
              active: true,
              id: small.id,
              question_id: size.id,
              sort_order: 0,
              text: "Small",
              times_selected: 0,
            },
            {
              active: true,
              id: large.id,
              question_id: size.id,
              sort_order: 1,
              text: "Large",
              times_selected: 0,
            },
            {
              active: true,
              id: expect.any(Number),
              question_id: size.id,
              sort_order: 2,
              text: "Medium",
              times_selected: 0,
            },
          ]);
        },
      );
    });

    test("names every listing the booking holds, in ascending order", async () => {
      const { listing, size, small } = await seedChoiceAndTextQuestions();
      const second = await createTestListing();
      await bookAnswer(listing.id, {
        answers: [{ answerId: small.id, questionId: size.id }],
        created: "2026-06-05T09:00:00Z",
        // The larger listing id first, so an unsorted answer shows it.
        lines: [
          { listingId: Math.max(listing.id, second.id), quantity: 1 },
          { listingId: Math.min(listing.id, second.id), quantity: 1 },
        ],
      });

      await assertJson(
        apiRequest(`/api/admin/questions/${size.id}/bookings`),
        200,
        (body) => {
          expect(body.bookings[0].listing_ids).toEqual(
            [listing.id, second.id].sort((left, right) => left - right),
          );
        },
      );
    });

    test("answers no listing ids for a booking that holds no line", async () => {
      const { listing, size, small } = await seedChoiceAndTextQuestions();
      const attendeeId = await bookAnswer(listing.id, {
        answers: [{ answerId: small.id, questionId: size.id }],
        created: "2026-06-04T09:00:00Z",
      });
      // A deleted listing removes its lines. The booking and its answer stay,
      // so the link answers with no listing to name.
      await execute(
        sql`DELETE FROM listing_attendees WHERE attendee_id = ${attendeeId}`,
      );

      await assertJson(
        apiRequest(`/api/admin/questions/${size.id}/bookings`),
        200,
        (body) => {
          expect(body.bookings).toEqual([
            {
              answer_id: small.id,
              answer_text: "Small",
              attendee_id: attendeeId,
              created: "2026-06-04T09:00:00.000Z",
              free_text: null,
              listing_ids: [],
              question_id: size.id,
            },
          ]);
        },
      );
    });

    test("returns 404 for a question that does not exist", async () => {
      await assertJson(
        apiRequest("/api/admin/questions/99999/bookings"),
        404,
        (body) => {
          expect(body.error).toBe("Question not found");
        },
      );
    });

    test("returns 401 without auth", async () => {
      const response = await handleRequest(
        mockRequest("/api/admin/questions/1/bookings"),
      );
      expect(response.status).toBe(401);
    });

    test("rejects a manager with 403 Forbidden", async () => {
      const { size } = await seedChoiceAndTextQuestions();
      const response = await handleRequest(
        requestAsSession(`/api/admin/questions/${size.id}/bookings`, {
          cookie: await createTestManagerSession(),
          csrfToken: await testCsrfToken(),
        }),
      );
      expect(response.status).toBe(403);
    });
  },
);

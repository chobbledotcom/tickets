/**
 * Direct tests for the answer maps at form parse: chosen and typed answers
 * file under the listing the question sits on, and empty answers give no map.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { AnswerInfo } from "#routes/public/ticket-form.ts";
import {
  computeListingAnswerMap,
  computeTextAnswerRefs,
} from "#routes/public/ticket-submit/parse.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { freeTextQuestionsOn } from "#test-utils/db-helpers/question-seeds.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";
import { testLineAnswer } from "#test-utils/factories-questions.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";
import {
  oneListingTicketContext,
  ticketContext,
} from "#test-utils/ticket-ctx.ts";

/** The submitted answers of a one-listing order: no answers at all unless
 * `chosen` or `typed` says otherwise. */
const answerInfo = (
  ctx: TicketCtx,
  listingId: number,
  chosen: { answerIds: number[]; textAnswers: AnswerInfo["textAnswers"] } = {
    answerIds: [],
    textAnswers: [],
  },
): AnswerInfo => ({
  activeQuestions: ctx.questions,
  lineTextAnswers: [],
  selectedListingIds: new Set([listingId]),
  ...chosen,
});

describeWithEnv("ticket-submit parse", { db: true }, () => {
  describe("the answer maps", () => {
    test("files chosen answer ids under the listing the question is on", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const { answerId } = await createQuestionWithAnswer([listing.id]);
      const ctx = await ticketContext([listing.id]);

      expect(
        computeListingAnswerMap(
          ctx,
          answerInfo(ctx, listing.id, {
            answerIds: [answerId],
            textAnswers: [],
          }),
        ),
      ).toEqual({ [String(listing.id)]: [answerId] });
    });

    test("is undefined when no answer was chosen", async () => {
      const { ctx, listing } = await oneListingTicketContext();

      expect(computeListingAnswerMap(ctx, answerInfo(ctx, listing.id))).toBe(
        undefined,
      );
    });

    test("gives text answers their stored string ids, keyed per listing", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const [question] = await freeTextQuestionsOn(listing.id, [
        "Say something",
      ]);
      const ctx = await ticketContext([listing.id]);

      const { listingTextAnswerIds } = await computeTextAnswerRefs(
        ctx,
        answerInfo(ctx, listing.id, {
          answerIds: [],
          textAnswers: [{ questionId: question.id, text: "Hello" }],
        }),
      );
      const entry = listingTextAnswerIds?.[String(listing.id)]?.[0];
      expect(entry?.q).toBe(question.id);
      expect(entry?.s).toBeGreaterThan(0);
    });

    test("has no text map when no text answer was given", async () => {
      const { ctx, listing } = await oneListingTicketContext();

      expect(
        await computeTextAnswerRefs(ctx, answerInfo(ctx, listing.id)),
      ).toStrictEqual({});
    });

    test("carries each line's own answers with its slot and ticket", async () => {
      const [first, second] = [
        await createTestListing({ maxAttendees: 5 }),
        await createTestListing({ maxAttendees: 5 }),
      ];
      const ctx = await ticketContext([first.id, second.id]);

      const refsFor = (lineTextAnswers: AnswerInfo["lineTextAnswers"]) =>
        computeTextAnswerRefs(ctx, {
          ...answerInfo(ctx, first.id),
          lineTextAnswers,
        });
      const refs =
        (
          await refsFor([
            testLineAnswer(first.id, 7, "Ava"),
            testLineAnswer(first.id, 7, "Amy", { unit: 1 }),
            testLineAnswer(second.id, 7, "Ben"),
          ])
        ).lineTextAnswerIds ?? [];

      expect(refs.map(({ s: _s, ...ref }) => ref)).toEqual([
        { g: 0, l: first.id, p: 0, q: 7, u: 0 },
        { g: 0, l: first.id, p: 0, q: 7, u: 1 },
        { g: 0, l: second.id, p: 0, q: 7, u: 0 },
      ]);
      expect(new Set(refs.map(({ s }) => s)).size).toBe(3);
    });

    test("looks the strings up once, whatever mix of answers the order holds", async () => {
      const { ctx, listing } = await oneListingTicketContext();
      const typed = { questionId: 7, text: "Hello" };
      const own = testLineAnswer(listing.id, typed.questionId, "Ava");
      const lookups = (info: AnswerInfo) =>
        countDatabaseCalls(5, () => computeTextAnswerRefs(ctx, info));

      const [bookingOnly, lineOnly, both] = [
        await lookups(
          answerInfo(ctx, listing.id, { answerIds: [], textAnswers: [typed] }),
        ),
        await lookups({
          ...answerInfo(ctx, listing.id),
          lineTextAnswers: [own],
        }),
        await lookups({
          ...answerInfo(ctx, listing.id, {
            answerIds: [],
            textAnswers: [typed],
          }),
          lineTextAnswers: [own],
        }),
      ];

      expect([lineOnly, both]).toEqual([bookingOnly, bookingOnly]);
    });
  });
});

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
import { ticketContext } from "#test-utils/ticket-ctx.ts";

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
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id]);

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
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id]);

      expect(
        await computeTextAnswerRefs(ctx, answerInfo(ctx, listing.id)),
      ).toEqual({
        lineTextAnswerIds: undefined,
        listingTextAnswerIds: undefined,
      });
    });

    test("files each listing's own answers under that listing alone", async () => {
      const [first, second] = [
        await createTestListing({ maxAttendees: 5 }),
        await createTestListing({ maxAttendees: 5 }),
      ];
      const ctx = await ticketContext([first.id, second.id]);

      const { lineTextAnswerIds } = await computeTextAnswerRefs(ctx, {
        ...answerInfo(ctx, first.id),
        lineTextAnswers: [
          { listingId: first.id, questionId: 7, text: "Ava" },
          { listingId: second.id, questionId: 7, text: "Ben" },
        ],
      });

      expect(Object.keys(lineTextAnswerIds ?? {}).sort()).toEqual(
        [String(first.id), String(second.id)].sort(),
      );
      const [ava, ben] = [
        lineTextAnswerIds?.[String(first.id)],
        lineTextAnswerIds?.[String(second.id)],
      ];
      expect(ava?.map((ref) => ref.q)).toEqual([7]);
      expect(ben?.map((ref) => ref.q)).toEqual([7]);
      expect(ava?.[0]?.s).not.toBe(ben?.[0]?.s);
    });
  });
});

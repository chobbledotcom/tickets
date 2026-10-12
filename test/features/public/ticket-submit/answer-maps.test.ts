/**
 * Direct tests for the answer maps at form parse: chosen and typed answers
 * file under the listing the question sits on, and empty answers give no map.
 */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { questionListings } from "#db/questions/queries.ts";
import { questionsTable } from "#db/questions/tables.ts";
import type { AnswerInfo } from "#routes/public/ticket-form.ts";
import {
  computeListingAnswerMap,
  computeListingTextAnswerIdMap,
} from "#routes/public/ticket-submit/parse.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";
import { ticketContext } from "#test-utils/ticket-ctx.ts";

/* jscpd:ignore-end */

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

      expect(
        computeListingAnswerMap(ctx, answerInfo(ctx, listing.id)),
      ).toBeUndefined();
    });

    test("gives text answers their stored string ids, keyed per listing", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const question = await questionsTable.insert({
        displayType: "free_text",
        text: "Say something",
      });
      await questionListings.setIds(question.id, [listing.id]);
      const ctx = await ticketContext([listing.id]);

      const map = await computeListingTextAnswerIdMap(
        ctx,
        answerInfo(ctx, listing.id, {
          answerIds: [],
          textAnswers: [{ questionId: question.id, text: "Hello" }],
        }),
      );
      const entry = map?.[String(listing.id)]?.[0];
      expect(entry?.q).toBe(question.id);
      expect(entry?.s).toBeGreaterThan(0);
    });

    test("has no text map when no text answer was given", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id]);

      expect(
        await computeListingTextAnswerIdMap(ctx, answerInfo(ctx, listing.id)),
      ).toBeUndefined();
    });
  });
});

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAttendeeAnswersBatch } from "#shared/db/questions/attendee-answers/reads.ts";
import { setListingQuestions } from "#shared/db/questions/queries.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import {
  expectAttendeeCounts,
  expectFlash,
  expectReservedRedirectWithTokens,
} from "#test-utils/assertions.ts";
import { submitMultiTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

// jscpd:ignore-end

/** The multi-listing attendee `listingId` shares, and the set of answer ids
 * saved on it — the shared "look up what got recorded" step behind every
 * multi-listing custom-question assertion below. */
const getSharedAttendeeAnswers = async (
  listingId: number,
): Promise<number[]> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
  const attendees = await getAttendeesRaw(listingId);
  const attendeeId = attendees[0]!.id;
  const batch = await getAttendeeAnswersBatch([attendeeId], { texts: false });
  return batch.get(attendeeId) ?? [];
};

describeWithEnv(
  "server public > custom questions (ticket)",
  { db: true, triggers: true },
  () => {
    describe("ticket with custom questions", () => {
      const setupQuestionForListings = async (listingIds: number[]) => {
        const q = await questionsTable.insert({
          displayType: "radio",
          text: "Dietary needs?",
        });
        const a1 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 0,
          text: "None",
        });
        const a2 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 1,
          text: "Vegetarian",
        });
        for (const eid of listingIds) {
          await setListingQuestions(eid, [q.id]);
        }
        return { answer1: a1, answer2: a2, question: q };
      };

      test("saves answers for all attendees in ticket reservation", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Q1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Q2",
        });
        const { question, answer1 } = await setupQuestionForListings([
          listing1.id,
          listing2.id,
        ]);

        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "multiq@example.com",
          name: "Multi Q User",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`question_${question.id}`]: String(answer1.id),
        });
        expectReservedRedirectWithTokens(response);

        // With multi-listing attendees, both listings share one attendee.
        // The shared question's answer is saved once on the attendee.
        expect(await getSharedAttendeeAnswers(listing1.id)).toEqual([
          answer1.id,
        ]);
      });

      test("saves listing-specific answers only for each attendee", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Evt A",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Evt B",
        });
        // Question 1 assigned to listing1 only
        const q1 = await questionsTable.insert({
          displayType: "radio",
          text: "Listing A question?",
        });
        const a1 = await answersTable.insert({
          questionId: q1.id,
          sortOrder: 0,
          text: "A answer",
        });
        await setListingQuestions(listing1.id, [q1.id]);

        // Question 2 assigned to listing2 only
        const q2 = await questionsTable.insert({
          displayType: "radio",
          text: "Listing B question?",
        });
        const a2 = await answersTable.insert({
          questionId: q2.id,
          sortOrder: 0,
          text: "B answer",
        });
        await setListingQuestions(listing2.id, [q2.id]);

        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "perlisting@example.com",
          name: "Per Listing User",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          [`question_${q1.id}`]: String(a1.id),
          [`question_${q2.id}`]: String(a2.id),
        });
        expectReservedRedirectWithTokens(response);

        // With multi-listing attendees, one attendee is linked to both listings.
        // Both listings' answers are stored on the same attendee.
        const answers = await getSharedAttendeeAnswers(listing1.id);
        expect(answers).toContain(a1.id);
        expect(answers).toContain(a2.id);
      });

      test("skips non-selected listings in listing answer map", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Q Shared 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Q Shared 2",
        });
        // Question assigned to BOTH listings
        const q1 = await questionsTable.insert({
          displayType: "radio",
          text: "Shared question?",
        });
        const a1 = await answersTable.insert({
          questionId: q1.id,
          sortOrder: 0,
          text: "Shared answer",
        });
        await setListingQuestions(listing1.id, [q1.id]);
        await setListingQuestions(listing2.id, [q1.id]);

        const slug = `${listing1.slug}+${listing2.slug}`;
        // Only select listing1, skip listing2
        const response = await submitMultiTicketForm(slug, {
          email: "shared@example.com",
          name: "Shared Q User",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "0",
          [`question_${q1.id}`]: String(a1.id),
        });
        expectReservedRedirectWithTokens(response);

        // Verify answer saved only for listing1's attendee
        await expectAttendeeCounts([
          { count: 1, listingId: listing1.id },
          { count: 0, listingId: listing2.id },
        ]);
        expect(await getSharedAttendeeAnswers(listing1.id)).toEqual([a1.id]);
      });

      test("validates question answers for selected listings only", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Q Filter 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Q Filter 2",
        });
        // Only assign question to listing1
        const q = await questionsTable.insert({
          displayType: "radio",
          text: "Listing1 question?",
        });
        await answersTable.insert({
          questionId: q.id,
          sortOrder: 0,
          text: "Yes",
        });
        await setListingQuestions(listing1.id, [q.id]);

        // Select only listing2 (no question assigned) - should succeed without answer
        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "filter@example.com",
          name: "Filter User",
          [`quantity_${listing1.id}`]: "0",
          [`quantity_${listing2.id}`]: "1",
        });
        expectReservedRedirectWithTokens(response);
      });

      test("returns error when ticket question is unanswered", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Q Error 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Q Error 2",
        });
        await setupQuestionForListings([listing1.id]);

        const slug = `${listing1.slug}+${listing2.slug}`;
        const response = await submitMultiTicketForm(slug, {
          email: "error@example.com",
          name: "Error User",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "0",
          // No question answer provided
        });
        expect(response.status).toBe(302);
        expectFlash(response, expect.stringContaining("Please answer"), false);
      });
    });
  },
);

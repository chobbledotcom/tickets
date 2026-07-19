// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { getAttendeeAnswersBatch } from "#shared/db/questions/attendee-answers/reads.ts";
import { listingQuestions } from "#shared/db/questions/queries.ts";
import { assignQuestion } from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookingPageHtml,
  bookParent,
  expectRejectedBooking,
  expectReserved,
  makeParent,
  makeTwoDefaultChildren,
  parentField,
} from "#test-utils/parents.ts";

// jscpd:ignore-end

const assignQuestionId = async (
  listingId: number,
  text: string,
  answer = "Yes",
): Promise<number> =>
  (await assignQuestion(listingId, text, answer)).question.id;

const expectQuestionControls = (html: string, questionIds: number[]): void => {
  for (const questionId of questionIds) {
    expect(html).toContain(`name="question_${questionId}"`);
  }
};

describeWithEnv(
  "public reservations > child block > questions",
  { db: true, triggers: true },
  () => {
    test("a selected child's question is non-required and saved", async () => {
      const { parent, child } = await makeParent();
      const { question, answer } = await assignQuestion(
        child.id,
        "Size?",
        "Large",
      );

      const html = await bookingPageHtml(parent.slug);
      expect(html.split(`name="question_${question.id}"`).length - 1).toBe(1);
      expect(html).toContain(
        `class="custom-question" data-listing-ids="${child.id}"`,
      );
      expect(html).not.toContain(`name="question_${question.id}" required`);

      const res = await bookParent(parent.slug, {
        ...parentField(parent, "1"),
        [`question_${question.id}`]: String(answer.id),
      });
      expectReserved(res);
      const childRows = await getAttendeesRaw(child.id);
      const batch = await getAttendeeAnswersBatch([childRows[0]!.id], {
        texts: false,
      });
      expect(batch.get(childRows[0]!.id)).toEqual([answer.id]);
    });

    test("a required child question rejects a missing answer", async () => {
      const { parent, child } = await makeParent();
      await assignQuestionId(child.id, "Size?", "Large");

      const res = await bookParent(parent.slug, parentField(parent, "1"));
      await expectRejectedBooking(res, parent.id);
    });

    test("different child questions all render with their listing ids", async () => {
      const { parent, childA, childB } = await makeTwoDefaultChildren();
      const questionAId = await assignQuestionId(
        childA.id,
        "First child question?",
      );
      const questionBId = await assignQuestionId(
        childB.id,
        "Second child question?",
      );

      const html = await bookingPageHtml(parent.slug);
      expectQuestionControls(html, [questionAId, questionBId]);
      expect(html).toContain(`data-listing-ids="${childA.id}"`);
      expect(html).toContain(`data-listing-ids="${childB.id}"`);
      expect(html).toContain(
        `</fieldset><fieldset class="custom-question" data-listing-ids="${childB.id}">`,
      );
    });

    test("one child's questions render next to each other", async () => {
      const { parent, child } = await makeParent();
      const questionAId = await assignQuestionId(child.id, "First question?");
      const questionBId = await assignQuestionId(child.id, "Second question?");
      await listingQuestions.setIds(child.id, [questionAId, questionBId]);

      const html = await bookingPageHtml(parent.slug);
      expectQuestionControls(html, [questionAId, questionBId]);
      expect(html).toContain(
        `</fieldset><fieldset class="custom-question" data-listing-ids="${child.id}">`,
      );
    });

    test("a question shared by sibling children renders once", async () => {
      const { parent, childA, childB } = await makeTwoDefaultChildren();
      const pageQuestionId = await assignQuestionId(
        parent.id,
        "Parent question?",
      );
      const sharedQuestionId = await assignQuestionId(
        childA.id,
        "Shared child question?",
        "Maybe",
      );
      await listingQuestions.setIds(childB.id, [sharedQuestionId]);

      const html = await bookingPageHtml(parent.slug);
      expect(html).toContain(`name="question_${pageQuestionId}" required`);
      expect(html.split(`name="question_${sharedQuestionId}"`).length - 1).toBe(
        1,
      );
      expect(html).toContain(`data-listing-ids="${childA.id} ${childB.id}"`);
      expect(html).not.toContain(
        `name="question_${sharedQuestionId}" required`,
      );
    });

    test("an all-deactivated child choice question does not render", async () => {
      const { parent, child } = await makeParent();
      const { question } = await assignQuestion(
        child.id,
        "Dead question?",
        "Inactive",
        false,
      );

      const html = await bookingPageHtml(parent.slug);
      expect(html).not.toContain(`name="question_${question.id}"`);
    });
  },
);

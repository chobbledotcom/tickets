// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  answersTable,
  questionsTable,
  setListingQuestions,
} from "#shared/db/questions.ts";
import {
  adminFormPost,
  adminGet,
  buildAttendeeEditForm,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
} from "#test-utils";

// jscpd:ignore-end
describeWithEnv(
  "server (admin attendees) > attendee questions",
  { db: true },
  () => {
    describe("edit attendee questions", () => {
      const setupQuestionAndAttendee = async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        // Create attendee before assigning questions (public route requires answers)
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
        const q = await questionsTable.insert({
          displayType: "radio",
          text: "T-shirt size?",
        });
        const a1 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 0,
          text: "Small",
        });
        const a2 = await answersTable.insert({
          questionId: q.id,
          sortOrder: 1,
          text: "Large",
        });
        await setListingQuestions(listing.id, [q.id]);
        return { a1, a2, attendee, listing, q };
      };

      test("shows questions on edit page", async () => {
        const { attendee } = await setupQuestionAndAttendee();
        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        await expectHtmlResponse(
          response,
          200,
          "T-shirt size?",
          "Small",
          "Large",
        );
      });

      test("pre-selects existing answer on edit page", async () => {
        const { attendee, a1, q } = await setupQuestionAndAttendee();
        const { saveAttendeeAnswers } = await import("#shared/db/questions.ts");
        await saveAttendeeAnswers(new Map([[attendee.id, [a1.id]]]));

        const response = await adminGet(`/admin/attendees/${attendee.id}/edit`);
        const html = await response.text();
        // The radio for the previously-saved answer is pre-checked.
        expect(html).toContain(
          `<input checked name="question_${q.id}" type="radio" value="${a1.id}">`,
        );
      });

      test("does not show questions when listing has none", async () => {
        const listing = await createTestListing({ maxAttendees: 100 });
        const attendee = await createTestAttendee(
          listing.id,
          listing.slug,
          "Jane Doe",
          "jane@example.com",
        );
        const response = await adminGet(`/admin/attendees/${attendee.id}`);
        const html = await response.text();
        expect(html).not.toContain("custom-question");
      });

      test("saves selected answer on edit", async () => {
        const { attendee, q, a2 } = await setupQuestionAndAttendee();
        const form = await buildAttendeeEditForm(attendee.id, {
          email: "john@example.com",
          extra: { [`question_${q.id}`]: String(a2.id) },
          name: "John Doe",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);

        const { getAttendeeAnswersBatch } = await import(
          "#shared/db/questions.ts"
        );
        const answers = await getAttendeeAnswersBatch([attendee.id], {
          texts: false,
        });
        expect(answers.get(attendee.id)).toEqual([a2.id]);
      });

      test("updates answer from one option to another", async () => {
        const { attendee, q, a1, a2 } = await setupQuestionAndAttendee();
        const { saveAttendeeAnswers, getAttendeeAnswersBatch } = await import(
          "#shared/db/questions.ts"
        );
        await saveAttendeeAnswers(new Map([[attendee.id, [a1.id]]]));

        const form = await buildAttendeeEditForm(attendee.id, {
          email: "john@example.com",
          extra: { [`question_${q.id}`]: String(a2.id) },
          name: "John Doe",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);

        const answers = await getAttendeeAnswersBatch([attendee.id], {
          texts: false,
        });
        expect(answers.get(attendee.id)).toEqual([a2.id]);
      });

      test("clears answers when no question field submitted", async () => {
        const { attendee, a1 } = await setupQuestionAndAttendee();
        const { saveAttendeeAnswers, getAttendeeAnswersBatch } = await import(
          "#shared/db/questions.ts"
        );
        await saveAttendeeAnswers(new Map([[attendee.id, [a1.id]]]));

        const form = await buildAttendeeEditForm(attendee.id, {
          email: "john@example.com",
          name: "John Doe",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);

        const answers = await getAttendeeAnswersBatch([attendee.id], {
          texts: false,
        });
        const attendeeAnswers = answers.get(attendee.id) ?? [];
        expect(attendeeAnswers.length).toBe(0);
      });

      test("ignores invalid answer ID for question", async () => {
        const { attendee, q } = await setupQuestionAndAttendee();

        const form = await buildAttendeeEditForm(attendee.id, {
          email: "john@example.com",
          extra: { [`question_${q.id}`]: "99999" },
          name: "John Doe",
        });
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        expect(response.status).toBe(302);

        const { getAttendeeAnswersBatch } = await import(
          "#shared/db/questions.ts"
        );
        const answers = await getAttendeeAnswersBatch([attendee.id], {
          texts: false,
        });
        const attendeeAnswers = answers.get(attendee.id) ?? [];
        expect(attendeeAnswers.length).toBe(0);
      });
    });
  },
);

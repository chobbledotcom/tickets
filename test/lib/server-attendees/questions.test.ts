// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  adminGet,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
} from "#test-utils";

// jscpd:ignore-end
import {
  attendeeAnswerIds,
  saveAttendeeAnswer,
  setupListingWithQuestion,
  submitAttendeeEdit,
  submitQuestionAnswer,
} from "./helpers.ts";

describeWithEnv(
  "server (admin attendees) > attendee questions",
  { db: true },
  () => {
    describe("edit attendee questions", () => {
      test("shows questions on edit page", async () => {
        const { attendee } = await setupListingWithQuestion(
          "T-shirt size?",
          "Small",
          "Large",
        );
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
        const { attendee, a1, q } = await setupListingWithQuestion(
          "T-shirt size?",
          "Small",
          "Large",
        );
        await saveAttendeeAnswer(attendee.id, a1.id);

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
        const { attendee, q, a2 } = await setupListingWithQuestion(
          "T-shirt size?",
          "Small",
          "Large",
        );
        expect(await submitQuestionAnswer(attendee.id, q.id, a2.id)).toEqual([
          a2.id,
        ]);
      });

      test("updates answer from one option to another", async () => {
        const { attendee, q, a1, a2 } = await setupListingWithQuestion(
          "T-shirt size?",
          "Small",
          "Large",
        );
        await saveAttendeeAnswer(attendee.id, a1.id);
        expect(await submitQuestionAnswer(attendee.id, q.id, a2.id)).toEqual([
          a2.id,
        ]);
      });

      test("clears answers when no question field submitted", async () => {
        const { attendee, a1 } = await setupListingWithQuestion(
          "T-shirt size?",
          "Small",
          "Large",
        );
        await saveAttendeeAnswer(attendee.id, a1.id);

        const response = await submitAttendeeEdit(attendee.id, {
          email: "john@example.com",
          name: "John Doe",
        });
        expect(response.status).toBe(302);
        expect((await attendeeAnswerIds(attendee.id)).length).toBe(0);
      });

      test("ignores invalid answer ID for question", async () => {
        const { attendee, q } = await setupListingWithQuestion(
          "T-shirt size?",
          "Small",
          "Large",
        );
        const response = await submitAttendeeEdit(attendee.id, {
          email: "john@example.com",
          extra: { [`question_${q.id}`]: "99999" },
          name: "John Doe",
        });
        expect(response.status).toBe(302);
        expect((await attendeeAnswerIds(attendee.id)).length).toBe(0);
      });
    });
  },
);

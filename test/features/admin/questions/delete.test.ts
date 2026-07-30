import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { answerTextForm, questionTextForm } from "#routes/admin/questions.ts";
import { createQuestion } from "#test/test-utils/questions/helpers.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import {
  expectFlashRedirect,
  expectStatus,
  inputNamed,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "server (admin question forms and delete)",
  { db: true },
  () => {
    describe("the two question forms", () => {
      // The expected labels, hints, and choices are written out here so a
      // changed form definition fails this test instead of moving along.
      test("serves the question box with its label, hint, and required flag", () => {
        const html = questionTextForm.render();
        expect(html).toContain("Question text");
        const text = inputNamed(html, "text");
        expect(text).toContain('placeholder="e.g. What is your T-shirt size?"');
        expect(text).toContain("required");
      });

      test("serves the display-as choice with all three ways to show it", () => {
        const html = questionTextForm.render();
        expect(html).toContain("Display as");
        expect(html).toContain(">Radio buttons<");
        expect(html).toContain(">Select box<");
        expect(html).toContain(">Free text<");
        // The choices carry their stored values in order.
        expect(html).toContain('value="radio"');
        expect(html).toContain('value="select"');
        expect(html).toContain('value="free_text"');
      });

      test("serves the answer box with its label and hint", () => {
        const html = answerTextForm.render();
        expect(html).toContain("Answer text");
        expect(inputNamed(html, "text")).toContain('placeholder="e.g. Medium"');
      });
    });

    describe("POST /admin/questions/:id/delete", () => {
      test("deleting needs the exact question text", async () => {
        const id = await createQuestion("Doomed question?");

        const { response } = await adminFormPost(
          `/admin/questions/${id}/delete`,
          { confirm_identifier: "Wrong" },
        );

        await expectFlashRedirect(
          `/admin/questions/${id}/delete`,
          expect.stringContaining("Question text does not match"),
          false,
        )(response);
        expectStatus(200)(await adminGet(`/admin/questions/${id}`));
      });

      test("deleting removes the question, logs it, and says so", async () => {
        const id = await createQuestion("Doomed question?");

        const { response } = await adminFormPost(
          `/admin/questions/${id}/delete`,
          { confirm_identifier: "Doomed question?" },
        );

        await expectFlashRedirect(
          "/admin/questions",
          "Question deleted",
          true,
        )(response);
        expectStatus(404)(await adminGet(`/admin/questions/${id}`));
        expect(await activityMessages()).toContain(
          "Question 'Doomed question?' deleted",
        );
      });
    });
  },
);

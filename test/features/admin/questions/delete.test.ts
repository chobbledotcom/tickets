import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllQuestionsWithAnswers } from "#shared/db/questions/queries.ts";
import { createQuestion } from "#test/test-utils/questions/helpers.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectFlashRedirect, expectStatus } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withFailingOrderTrigger } from "#test-utils/db-helpers/failing-order.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv(
  "server (admin question forms and delete)",
  { db: true },
  () => {
    describe("rollback on a failed order write", () => {
      test("a failed order write leaves no half-made question behind", async () => {
        // The insert and the order write run in one transaction, so the
        // question must roll back with a failed append.
        await withFailingOrderTrigger("questions", async () => {
          await expect(
            adminFormPost("/admin/questions", {
              display_type: "radio",
              text: "Ghost?",
            }),
          ).rejects.toThrow("order write failed");
        });
        expect(await getAllQuestionsWithAnswers()).toEqual([]);
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

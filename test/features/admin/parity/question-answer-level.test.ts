// Behaviour pins for the answer level of a question: how often it asks. The
// add form sets it when a question is created, and nothing can change it
// afterwards.
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getQuestionWithAnswers } from "#db/questions/queries.ts";
import { t } from "#i18n";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { seedListingLevelQuestion } from "#test-utils/db-helpers/question-seeds.ts";
import { describeWithQuestions as describeWithEnv } from "#test-utils/feature-suites.ts";
import { adminGet } from "#test-utils/session.ts";
import { ownerPagePost } from "./helpers.ts";

describeWithEnv("Question answer level pins", { db: true }, () => {
  /** The id of a free-text question that asks once for each listing. */
  const createdListingLevel = async (): Promise<number> =>
    (await seedListingLevelQuestion()).question.id;

  test("the add form creates a question that asks once for each listing", async () => {
    const response = await ownerPagePost("/admin/questions", {
      answerLevel: "listing",
      displayType: "free_text",
      text: "Pupil name on the page",
    });
    expect(response.status).toBe(302);
    const id = Number(
      /\/admin\/questions\/(\d+)/.exec(response.headers.get("location")!)![1],
    );
    expect((await getQuestionWithAnswers(id))?.answerLevel).toBe("listing");
  });

  test("the edit form refuses a changed level and keeps the stored one", async () => {
    const id = await createdListingLevel();
    const response = await ownerPagePost(`/admin/questions/${id}/edit`, {
      answerLevel: "booking",
      displayType: "free_text",
      text: "Pupil name",
    });
    expect(response.status).toBe(400);
    expectIncludesAll(await response.text(), [
      t("questions.answer_level.locked"),
    ]);
    expect((await getQuestionWithAnswers(id))?.answerLevel).toBe("listing");
  });

  test("the edit form posts the stored level, so a plain save keeps it", async () => {
    const id = await createdListingLevel();
    const page = await (await adminGet(`/admin/questions/${id}`)).text();
    expectIncludesAll(page, [
      'name="answerLevel"',
      'type="hidden" value="listing"',
      "This question asks: One per listing.",
    ]);
  });
});

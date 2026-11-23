// Behaviour pins for the answer level of a question: how often it asks. The
// add form sets it when a question is created, and nothing can change it
// afterwards.
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { seedListingLevelQuestion } from "#test-utils/db-helpers/question-seeds.ts";
import { describeWithQuestions as describeWithEnv } from "#test-utils/feature-suites.ts";
import { adminGet } from "#test-utils/session.ts";
import { ownerPagePost } from "./helpers.ts";

const ASKS_EACH_LISTING = "This question asks: One per listing.";

describeWithEnv("Question answer level pins", { db: true }, () => {
  /** The id of a free-text question that asks once for each listing. */
  const createdListingLevel = async (): Promise<number> =>
    (await seedListingLevelQuestion()).question.id;

  /** The question page, which says how often the question asks. */
  const askedOn = async (id: number): Promise<string> =>
    (await adminGet(`/admin/questions/${id}`)).text();

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
    expect(await askedOn(id)).toContain(ASKS_EACH_LISTING);
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
    expect(await askedOn(id)).toContain(ASKS_EACH_LISTING);
  });

  test("the edit form posts the stored level, so a plain save keeps it", async () => {
    const id = await createdListingLevel();
    const page = await (await adminGet(`/admin/questions/${id}`)).text();
    expectIncludesAll(page, [
      'name="answerLevel"',
      'type="hidden" value="listing"',
      ASKS_EACH_LISTING,
    ]);
  });
});

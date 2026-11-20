// Behaviour pins for the answer level of a question: how often it asks. The
// page and the JSON API set it when a question is created, and neither can
// change it afterwards.
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { questionAnswerLevelError } from "#db/question-types.ts";
import { getQuestionWithAnswers } from "#db/questions/queries.ts";
import { t } from "#i18n";
import {
  assertJson,
  expectIncludesAll,
  expectRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithQuestions as describeWithEnv } from "#test-utils/feature-suites.ts";
import { adminGet } from "#test-utils/session.ts";
import { ownerApiPost, ownerApiPut, ownerPagePost } from "./helpers.ts";

describeWithEnv("Question answer level pins", { db: true }, () => {
  /** The id of a question that the API creates. */
  const createdId = async (body: Record<string, unknown>): Promise<number> =>
    (
      await assertJson<{ question: { id: number } }>(
        ownerApiPost("/api/admin/questions", body),
        201,
      )
    ).question.id;

  test("the API creates a free-text question that asks once for each listing", async () => {
    const created = await assertJson<{
      question: { answer_level: string; id: number };
    }>(
      ownerApiPost("/api/admin/questions", {
        answer_level: "listing",
        display_type: "free_text",
        text: "Pupil name",
      }),
      201,
    );
    expect(created.question.answer_level).toBe("listing");
    expect(
      (await getQuestionWithAnswers(created.question.id))?.answerLevel,
    ).toBe("listing");
  });

  test("the API asks once for the booking when the body names no level", async () => {
    const id = await createdId({ display_type: "free_text", text: "Note" });
    expect((await getQuestionWithAnswers(id))?.answerLevel).toBe("booking");
  });

  test("the API keeps a choice question at one per booking", async () => {
    const id = await createdId({
      answer_level: "listing",
      display_type: "radio",
      text: "Size?",
    });
    expect((await getQuestionWithAnswers(id))?.answerLevel).toBe("booking");
  });

  test("the API refuses a level that is not on the list", async () => {
    const response = await ownerApiPost("/api/admin/questions", {
      answer_level: "ticket",
      display_type: "free_text",
      text: "Pupil name",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(questionAnswerLevelError);
  });

  test("the API refuses an update that changes the level", async () => {
    const id = await createdId({
      answer_level: "listing",
      display_type: "free_text",
      text: "Pupil name",
    });
    const response = await ownerApiPut(`/api/admin/questions/${id}`, {
      answer_level: "booking",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      t("questions.answer_level.locked"),
    );
    expect((await getQuestionWithAnswers(id))?.answerLevel).toBe("listing");
  });

  test("the API accepts an update that repeats the level", async () => {
    const id = await createdId({
      answer_level: "listing",
      display_type: "free_text",
      text: "Pupil name",
    });
    await assertJson(
      ownerApiPut(`/api/admin/questions/${id}`, {
        answer_level: "listing",
        text: "Pupil's name",
      }),
      200,
    );
    expect((await getQuestionWithAnswers(id))?.text).toBe("Pupil's name");
  });

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
    const id = await createdId({
      answer_level: "listing",
      display_type: "free_text",
      text: "Pupil name",
    });
    const response = await ownerPagePost(`/admin/questions/${id}/edit`, {
      answerLevel: "booking",
      displayType: "free_text",
      text: "Pupil name",
    });
    expectRedirectWithFlash(
      `/admin/questions/${id}`,
      t("questions.answer_level.locked"),
      false,
    )(response);
    expect((await getQuestionWithAnswers(id))?.answerLevel).toBe("listing");
  });

  test("the edit form posts the stored level, so a plain save keeps it", async () => {
    const id = await createdId({
      answer_level: "listing",
      display_type: "free_text",
      text: "Pupil name",
    });
    const page = await (await adminGet(`/admin/questions/${id}`)).text();
    expectIncludesAll(page, [
      'name="answerLevel"',
      'type="hidden" value="listing"',
      "This question asks: One per listing.",
    ]);
  });

  test("the questions list names how often each question asks", async () => {
    await createdId({
      answer_level: "listing",
      display_type: "free_text",
      text: "Pupil name",
    });
    const page = await (await adminGet("/admin/questions")).text();
    expectIncludesAll(page, [
      "One per listing",
      t("questions.answer_level_column"),
    ]);
  });
});

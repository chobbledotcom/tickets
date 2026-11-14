// Behaviour pins for the questions resource: what each surface answers
// today, one test per fact. The page posts to /admin/questions (OWNER_FORM);
// the JSON API posts to /api/admin/questions (OWNER_API). Both surfaces are
// owner-only. The API reuses the form's own words wherever it can, so the
// same-message pins are the contract; the required-text pin records the one
// deliberate word difference (the form names the label, the API names the key).
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { questionDisplayTypeError } from "#db/question-types.ts";
import {
  getAllQuestionsWithAnswers,
  getQuestionWithAnswers,
} from "#db/questions/queries.ts";
import { t } from "#i18n";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { assertJson, expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  ownerApiGet,
  ownerApiPost,
  ownerApiPut,
  ownerPagePost,
} from "./helpers.ts";

describeWithEnv("Question parity pins", { db: true }, () => {
  const maxLengthMessage = (label: string, max: number): string =>
    t("fields.validation.max_length", { label, max });

  /** The stored question row, found by its text. */
  const storedQuestion = async (text: string) => {
    const row = (await getAllQuestionsWithAnswers()).find(
      (q) => q.text === text,
    );
    if (!row) throw new Error(`no question was stored for ${text}`);
    return row;
  };

  /** The id of a question that the API creates. */
  const createdQuestionId = async (
    body: Record<string, unknown>,
  ): Promise<number> => {
    const created = await assertJson<{ question: { id: number } }>(
      ownerApiPost("/api/admin/questions", body),
      201,
    );
    return created.question.id;
  };

  /** Save the question from its edit page and check the flash. */
  const editOnPage = async (
    id: number,
    data: Record<string, string>,
  ): Promise<void> => {
    const page = await ownerPagePost(`/admin/questions/${id}/edit`, data);
    expectRedirectWithFlash(`/admin/questions/${id}`, "Question updated")(page);
  };

  /** Change the question through the API and check the fields it keeps. */
  const expectPutKeeps = async (
    id: number,
    body: Record<string, unknown>,
    kept: Record<string, unknown>,
  ): Promise<void> => {
    const answer = await assertJson<{ question: Record<string, unknown> }>(
      ownerApiPut(`/api/admin/questions/${id}`, body),
      200,
    );
    expect(answer.question).toMatchObject(kept);
  };

  /** The routes of one refusal: the page post, the page it returns to, and
   *  the API post. */
  type RefusalRoutes = { api: string; back: string; page: string };

  /** Pin one refusal on both surfaces: the page answers it as a flash
   *  redirect, the API as a 400. */
  const expectRefused = async (
    routes: RefusalRoutes,
    pageData: Record<string, string>,
    apiBody: Record<string, unknown>,
    pageMessage: string,
    apiMessage: string,
  ): Promise<void> => {
    const page = await ownerPagePost(routes.page, pageData);
    expectRedirectWithFlash(routes.back, pageMessage, false)(page);

    const api = await ownerApiPost(routes.api, apiBody);
    expect(api.status).toBe(400);
    expect((await api.json()).error).toBe(apiMessage);
  };

  /** Pin one refused question on both surfaces. The API uses the page's
   *  words unless the test names its own. */
  const expectCreateRefused = (
    data: Record<string, string>,
    pageMessage: string,
    apiMessage = pageMessage,
  ): Promise<void> =>
    expectRefused(
      {
        api: "/api/admin/questions",
        back: "/admin/questions",
        page: "/admin/questions",
      },
      data,
      data,
      pageMessage,
      apiMessage,
    );

  /** Pin one refused answer on both surfaces. Both use the same words, and
   *  no answer is stored. */
  const expectAnswerRefused = async (
    id: number,
    message: string,
    pageText: string,
    apiText: string,
  ): Promise<void> => {
    await expectRefused(
      {
        api: `/api/admin/questions/${id}/answers`,
        back: `/admin/questions/${id}`,
        page: `/admin/questions/${id}/answers`,
      },
      { text: pageText },
      { text: apiText },
      message,
      message,
    );
    expect((await getQuestionWithAnswers(id))!.answers).toEqual([]);
  };

  test("page create stores the posted text and type", async () => {
    const response = await ownerPagePost("/admin/questions", {
      display_type: "radio",
      text: "Pinned page question?",
    });
    const row = await storedQuestion("Pinned page question?");
    expectRedirectWithFlash(
      `/admin/questions/${row.id}`,
      "Question created",
    )(response);
    expect(row.display_type).toBe("radio");
  });

  test("both surfaces refuse a question text past the textarea cap with the same message", async () => {
    await expectCreateRefused(
      { display_type: "radio", text: "x".repeat(MAX_TEXTAREA_LENGTH + 1) },
      maxLengthMessage(t("questions.name_label"), MAX_TEXTAREA_LENGTH),
    );
  });

  test("both surfaces accept a question text exactly at the textarea cap", async () => {
    const id = await createdQuestionId({
      display_type: "select",
      text: "y".repeat(MAX_TEXTAREA_LENGTH),
    });
    await assertJson(
      ownerApiGet(`/api/admin/questions/${id}`),
      200,
      (body: { question: { text: string } }) => {
        expect(body.question.text).toBe("y".repeat(MAX_TEXTAREA_LENGTH));
      },
    );

    const page = await ownerPagePost("/admin/questions", {
      display_type: "radio",
      text: "z".repeat(MAX_TEXTAREA_LENGTH),
    });
    expect(page.status).toBe(302);
    expect((await storedQuestion("z".repeat(MAX_TEXTAREA_LENGTH))).text).toBe(
      "z".repeat(MAX_TEXTAREA_LENGTH),
    );
  });

  test("each surface answers a missing question text in its own words", async () => {
    await expectCreateRefused(
      { display_type: "radio" },
      "Question text is required",
      "text is required",
    );
  });

  test("both surfaces refuse an unknown display type with the same message", async () => {
    await expectCreateRefused(
      { display_type: "dropdown", text: "Typed how?" },
      questionDisplayTypeError,
    );
  });

  // The page posts free_text each time. On a choice question the value is
  // crafted, because the selector carries the stored type. On a free-text
  // question a hidden field locks it.
  /* jscpd:ignore-start -- a list of strings, not code */
  const TYPE_KEPT_CASES = [
    {
      apiAsks: "free_text",
      name: "both surfaces keep a choice question choice when asked free text",
      pageText: "Pinned conversion question?",
      stored: "radio",
      text: "Pinned conversion question?",
    },
    {
      apiAsks: "radio",
      name: "both surfaces keep a free-text question free text",
      pageText: "Pinned free question, changed?",
      stored: "free_text",
      text: "Pinned free question?",
    },
  ];
  /* jscpd:ignore-end */

  for (const kept of TYPE_KEPT_CASES) {
    test(kept.name, async () => {
      const id = await createdQuestionId({
        display_type: kept.stored,
        text: kept.text,
      });
      await editOnPage(id, { display_type: "free_text", text: kept.pageText });
      expect((await getQuestionWithAnswers(id))!.display_type).toBe(
        kept.stored,
      );

      await expectPutKeeps(
        id,
        { display_type: kept.apiAsks },
        { display_type: kept.stored },
      );
    });
  }

  test("a silent update keeps the stored switch and type on both surfaces", async () => {
    const id = await createdQuestionId({
      assign_all: true,
      display_type: "select",
      text: "Pinned silent question?",
    });

    // The page edit form carries no assign-all switch, so its post is silent
    // about it.
    await editOnPage(id, {
      display_type: "select",
      text: "Pinned silent question, changed?",
    });

    const pageKept = await getQuestionWithAnswers(id)!;
    expect(pageKept).toMatchObject({
      assign_all: true,
      display_type: "select",
    });

    await expectPutKeeps(
      id,
      { text: "Still silent?" },
      { assign_all: true, display_type: "select" },
    );
  });

  test("both surfaces refuse an answer on a free-text question with the same message", async () => {
    const id = await createdQuestionId({
      display_type: "free_text",
      text: "Pinned no-options question?",
    });
    await expectAnswerRefused(
      id,
      t("questions.answers.free_text_no_options"),
      "Pinned refused answer",
      "Pinned refused answer",
    );
  });

  test("both surfaces refuse an answer text past the input cap with the same message", async () => {
    const id = await createdQuestionId({
      display_type: "radio",
      text: "Pinned long-answer question?",
    });
    await expectAnswerRefused(
      id,
      maxLengthMessage(t("questions.answer_label"), MAX_INPUT_LENGTH),
      "a".repeat(MAX_INPUT_LENGTH + 1),
      "b".repeat(MAX_INPUT_LENGTH + 1),
    );
  });

  test("both surfaces accept an answer text exactly at the input cap", async () => {
    const id = await createdQuestionId({
      display_type: "radio",
      text: "Pinned capped-answer question?",
    });

    await assertJson(
      ownerApiPost(`/api/admin/questions/${id}/answers`, {
        text: "c".repeat(MAX_INPUT_LENGTH),
      }),
      201,
    );

    const page = await ownerPagePost(`/admin/questions/${id}/answers`, {
      text: "d".repeat(MAX_INPUT_LENGTH),
    });
    expectRedirectWithFlash(
      `/admin/questions/${id}`,
      t("questions.answer_added"),
    )(page);
    expect(
      (await getQuestionWithAnswers(id))!.answers.map((a) => a.text),
    ).toEqual(["c".repeat(MAX_INPUT_LENGTH), "d".repeat(MAX_INPUT_LENGTH)]);
  });

  test("both surfaces list the question under the questions tab the operator reads", async () => {
    await ownerApiPost("/api/admin/questions", {
      display_type: "radio",
      text: "Pinned listed question?",
    });
    const row = await storedQuestion("Pinned listed question?");
    const listed = await assertJson<{
      questions: { id: number; text: string }[];
    }>(ownerApiGet("/api/admin/questions"), 200);
    expect(
      listed.questions.some((q) => q.id === row.id && q.text === row.text),
    ).toBe(true);
  });
});

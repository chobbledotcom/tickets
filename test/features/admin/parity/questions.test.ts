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

  test("page create stores the posted text and type", async () => {
    const response = await ownerPagePost("/admin/questions", {
      display_type: "radio",
      text: "Pinned page question?",
    });
    const row = await storedQuestion("Pinned page question?");
    expectRedirectWithFlash(
      `/admin/questions/${row.id}`,
      t("questions.created"),
    )(response);
    expect(row.display_type).toBe("radio");
  });

  test("both surfaces refuse a question text past the textarea cap with the same message", async () => {
    const message = maxLengthMessage(
      t("questions.name_label"),
      MAX_TEXTAREA_LENGTH,
    );
    const page = await ownerPagePost("/admin/questions", {
      display_type: "radio",
      text: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
    });
    expectRedirectWithFlash("/admin/questions", message, false)(page);

    const api = await ownerApiPost("/api/admin/questions", {
      display_type: "radio",
      text: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
    });
    expect(api.status).toBe(400);
    expect((await api.json()).error).toBe(message);
  });

  test("both surfaces accept a question text exactly at the textarea cap", async () => {
    const created = await assertJson<{ question: { id: number } }>(
      ownerApiPost("/api/admin/questions", {
        display_type: "select",
        text: "y".repeat(MAX_TEXTAREA_LENGTH),
      }),
      201,
    );
    await assertJson(
      ownerApiGet(`/api/admin/questions/${created.question.id}`),
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
    expect(await storedQuestion("z".repeat(MAX_TEXTAREA_LENGTH))).toBeDefined();
  });

  test("each surface answers a missing question text in its own words", async () => {
    const page = await ownerPagePost("/admin/questions", {
      display_type: "radio",
    });
    expectRedirectWithFlash(
      "/admin/questions",
      "Question text is required",
      false,
    )(page);

    const api = await ownerApiPost("/api/admin/questions", {
      display_type: "radio",
    });
    expect(api.status).toBe(400);
    expect((await api.json()).error).toBe("text is required");
  });

  test("both surfaces refuse an unknown display type with the same message", async () => {
    const page = await ownerPagePost("/admin/questions", {
      display_type: "dropdown",
      text: "Typed how?",
    });
    expectRedirectWithFlash(
      "/admin/questions",
      questionDisplayTypeError,
      false,
    )(page);

    const api = await ownerApiPost("/api/admin/questions", {
      display_type: "dropdown",
      text: "Typed how?",
    });
    expect(api.status).toBe(400);
    expect((await api.json()).error).toBe(questionDisplayTypeError);
  });

  test("both surfaces keep a choice question choice when asked free text", async () => {
    const created = await assertJson<{ question: { id: number } }>(
      ownerApiPost("/api/admin/questions", {
        display_type: "radio",
        text: "Pinned conversion question?",
      }),
      201,
    );
    const id = created.question.id;

    // The page posts the type its selector carries; a crafted free_text value
    // keeps the stored type.
    const page = await ownerPagePost(`/admin/questions/${id}/edit`, {
      display_type: "free_text",
      text: "Pinned conversion question?",
    });
    expectRedirectWithFlash(
      `/admin/questions/${id}`,
      t("questions.updated"),
    )(page);
    expect((await getQuestionWithAnswers(id))!.display_type).toBe("radio");

    await assertJson(
      ownerApiPut(`/api/admin/questions/${id}`, { display_type: "free_text" }),
      200,
      (body: { question: { display_type: string } }) => {
        expect(body.question.display_type).toBe("radio");
      },
    );
  });

  test("both surfaces keep a free-text question free text", async () => {
    const created = await assertJson<{ question: { id: number } }>(
      ownerApiPost("/api/admin/questions", {
        display_type: "free_text",
        text: "Pinned free question?",
      }),
      201,
    );
    const id = created.question.id;

    // The page locks the type with a hidden field, so its post carries
    // free_text.
    const page = await ownerPagePost(`/admin/questions/${id}/edit`, {
      display_type: "free_text",
      text: "Pinned free question, changed?",
    });
    expectRedirectWithFlash(
      `/admin/questions/${id}`,
      t("questions.updated"),
    )(page);
    expect((await getQuestionWithAnswers(id))!.display_type).toBe("free_text");

    await assertJson(
      ownerApiPut(`/api/admin/questions/${id}`, { display_type: "radio" }),
      200,
      (body: { question: { display_type: string } }) => {
        expect(body.question.display_type).toBe("free_text");
      },
    );
  });

  test("a silent update keeps the stored switch and type on both surfaces", async () => {
    const created = await assertJson<{ question: { id: number } }>(
      ownerApiPost("/api/admin/questions", {
        assign_all: true,
        display_type: "select",
        text: "Pinned silent question?",
      }),
      201,
    );
    const id = created.question.id;

    // The page edit form carries no assign-all switch, so its post is silent
    // about it.
    const page = await ownerPagePost(`/admin/questions/${id}/edit`, {
      display_type: "select",
      text: "Pinned silent question, changed?",
    });
    expectRedirectWithFlash(
      `/admin/questions/${id}`,
      t("questions.updated"),
    )(page);

    const pageKept = await getQuestionWithAnswers(id)!;
    expect(pageKept).toMatchObject({
      assign_all: true,
      display_type: "select",
    });

    await assertJson(
      ownerApiPut(`/api/admin/questions/${id}`, { text: "Still silent?" }),
      200,
      (body: { question: { assign_all: boolean; display_type: string } }) => {
        expect(body.question.assign_all).toBe(true);
        expect(body.question.display_type).toBe("select");
      },
    );
  });

  /** Pin one free-text question's answer refusal on both surfaces: the page
   *  answers it as a flash redirect, the API as a 400. Both use the same
   *  words. */
  const refuseAnswerOnFreeText = async (id: number): Promise<void> => {
    const message = t("questions.answers.free_text_no_options");
    const page = await ownerPagePost(`/admin/questions/${id}/answers`, {
      text: "Pinned refused answer",
    });
    expectRedirectWithFlash(`/admin/questions/${id}`, message, false)(page);

    const api = await ownerApiPost(`/api/admin/questions/${id}/answers`, {
      text: "Pinned refused answer",
    });
    expect(api.status).toBe(400);
    expect((await api.json()).error).toBe(message);
  };

  test("both surfaces refuse an answer on a free-text question with the same message", async () => {
    const created = await assertJson<{ question: { id: number } }>(
      ownerApiPost("/api/admin/questions", {
        display_type: "free_text",
        text: "Pinned no-options question?",
      }),
      201,
    );
    await refuseAnswerOnFreeText(created.question.id);
    expect(
      (await getQuestionWithAnswers(created.question.id))!.answers,
    ).toEqual([]);
  });

  test("both surfaces refuse an answer text past the input cap with the same message", async () => {
    const created = await assertJson<{ question: { id: number } }>(
      ownerApiPost("/api/admin/questions", {
        display_type: "radio",
        text: "Pinned long-answer question?",
      }),
      201,
    );
    const id = created.question.id;
    const message = maxLengthMessage(
      t("questions.answer_label"),
      MAX_INPUT_LENGTH,
    );

    const page = await ownerPagePost(`/admin/questions/${id}/answers`, {
      text: "a".repeat(MAX_INPUT_LENGTH + 1),
    });
    expectRedirectWithFlash(`/admin/questions/${id}`, message, false)(page);

    const api = await ownerApiPost(`/api/admin/questions/${id}/answers`, {
      text: "b".repeat(MAX_INPUT_LENGTH + 1),
    });
    expect(api.status).toBe(400);
    expect((await api.json()).error).toBe(message);
    expect((await getQuestionWithAnswers(id))!.answers).toEqual([]);
  });

  test("both surfaces accept an answer text exactly at the input cap", async () => {
    const created = await assertJson<{ question: { id: number } }>(
      ownerApiPost("/api/admin/questions", {
        display_type: "radio",
        text: "Pinned capped-answer question?",
      }),
      201,
    );
    const id = created.question.id;

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

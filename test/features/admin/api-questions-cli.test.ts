import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { runApi } from "#cli/run.ts";
import { getAllQuestionsWithAnswers } from "#db/questions/queries.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { adminApiTestTransport } from "#test-utils/admin-api-transport.ts";
import { runDeps } from "#test-utils/cli-table.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** The CLI drives the whole questions flow off the resource table: create a
 *  question, add its answers, read the shape back, then delete the answer and
 *  the question. One run per command, exactly as `deno task cli:api` runs. */
describeWithEnv("CLI questions flow", { db: true }, () => {
  const run = (args: string[]) =>
    runApi(args, runDeps(ADMIN_API_RESOURCES, adminApiTestTransport));

  test("creates, reads, and deletes a question and its answers", async () => {
    const created = await run([
      "create",
      "questions",
      '{"display_type":"radio","text":"What is your T-shirt size?"}',
    ]);
    const question = JSON.parse(created.out!).question;
    expect(question.assign_all).toBe(false);

    const small = await run([
      "create",
      "questions",
      `${question.id}/answers`,
      '{"text":"Small"}',
    ]);
    const withSmall = JSON.parse(small.out!).question;
    expect(withSmall.answers.map((a: { text: string }) => a.text)).toEqual([
      "Small",
    ]);

    await run([
      "create",
      "questions",
      `${question.id}/answers`,
      '{"text":"Large"}',
    ]);

    const read = await run(["get", "questions", String(question.id)]);
    const stored = JSON.parse(read.out!).question;
    expect(stored).toEqual({
      answers: [
        { ...withSmall.answers[0], text: "Small" },
        {
          active: true,
          id: expect.any(Number),
          question_id: question.id,
          sort_order: 1,
          text: "Large",
        },
      ],
      assign_all: false,
      display_type: "radio",
      id: question.id,
      text: "What is your T-shirt size?",
    });

    const listed = await run(["list", "questions"]);
    expect(JSON.parse(listed.out!).questions).toHaveLength(1);

    const answerDelete = await run([
      "delete",
      "questions",
      `${question.id}/answers/${stored.answers[1].id}`,
      '{"confirm_identifier":"Large"}',
    ]);
    expect(JSON.parse(answerDelete.out!)).toEqual({ status: "ok" });

    const questionDelete = await run([
      "delete",
      "questions",
      String(question.id),
      '{"confirm_identifier":"What is your T-shirt size?"}',
    ]);
    expect(JSON.parse(questionDelete.out!)).toEqual({ status: "ok" });
    expect(await getAllQuestionsWithAnswers()).toEqual([]);
  });

  test("refuses a delete whose confirmation does not match", async () => {
    const created = await run([
      "create",
      "questions",
      '{"display_type":"radio","text":"Guarded?"}',
    ]);
    const question = JSON.parse(created.out!).question;

    const failed = await run([
      "delete",
      "questions",
      String(question.id),
      '{"confirm_identifier":"Wrong"}',
    ]);
    // The server's 400 maps to the contract's validation exit code.
    expect(failed.code).toBe(3);
    assertStringIncludes(
      JSON.parse(failed.err!).error.message,
      "does not match",
    );
  });
});

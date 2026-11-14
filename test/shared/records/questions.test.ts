import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Question, QuestionDisplayType } from "#db/question-types.ts";
import { answersTable } from "#db/questions/tables.ts";
import { questionRecord, questionRule } from "#shared/records/questions.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";
import { expectRecordDelete } from "#test-utils/record-commands.ts";
import { describeRecord } from "#test-utils/record-labels.ts";

const LIMIT = 10_240;

const stored = (displayType: QuestionDisplayType): Question => ({
  assign_all: false,
  display_type: displayType,
  id: 1,
  text: "Stored",
});

/** The display type the rule keeps when `from` is edited to `to`. */
const keptDisplayType = (
  from: QuestionDisplayType,
  to: QuestionDisplayType,
) => {
  const ruled = questionRule({ displayType: to, text: "Q" }, stored(from));
  return ruled.ok ? ruled.value.displayType : ruled.error;
};

describe("the question rule", () => {
  test("refuses a text past the text area limit", () => {
    expect(
      questionRule({ displayType: "radio", text: "q".repeat(LIMIT + 1) }, null),
    ).toEqual({
      error: `Question text must be ${LIMIT} characters or fewer`,
      ok: false,
    });
  });

  test("accepts a new question at the text area limit", () => {
    const input = { displayType: "radio" as const, text: "q".repeat(LIMIT) };

    expect(questionRule(input, null)).toEqual({ ok: true, value: input });
  });

  test("lets a choice question switch between radio and select", () => {
    expect([
      keptDisplayType("radio", "select"),
      keptDisplayType("select", "radio"),
    ]).toEqual(["select", "radio"]);
  });

  test("keeps a free-text question free-text and a choice question a choice", () => {
    expect([
      keptDisplayType("free_text", "radio"),
      keptDisplayType("radio", "free_text"),
      keptDisplayType("free_text", "free_text"),
    ]).toEqual(["free_text", "radio", "free_text"]);
  });

  test("carries the rest of the input through an edit", () => {
    expect(
      questionRule(
        { assignAll: true, displayType: "select", text: "Pick" },
        stored("radio"),
      ),
    ).toEqual({
      ok: true,
      value: { assignAll: true, displayType: "select", text: "Pick" },
    });
  });
});

describe("the question record's names", () => {
  test("names a question by its text", () => {
    expect([
      questionRecord.nameOf(stored("radio")),
      questionRecord.logName({ displayType: "radio", text: "Typed" }),
    ]).toEqual(["Stored", "Typed"]);
  });
});

describeRecord(questionRecord, "Question", "Question text", () => {
  test("creates questions in order and logs each by its text", async () => {
    await questionRecord.create({ displayType: "radio", text: "First?" });
    await questionRecord.create({
      displayType: "free_text",
      text: "Second?",
    });

    expect(
      (await questionRecord.getAll()).map((question) => question.text),
    ).toEqual(["First?", "Second?"]);
    expect(await activityMessages()).toEqual([
      "Question 'Second?' created",
      "Question 'First?' created",
    ]);
  });

  test("deletes a question with its answers and logs it", async () => {
    const { questionId } = await createQuestionWithAnswer();

    await expectRecordDelete(questionRecord, questionId, [
      "Question 'Choose one' deleted",
    ]);
    expect(await answersTable.read.many({})).toEqual([]);
  });
});

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { Question, QuestionDisplayType } from "#db/question-types.ts";
import { readRows } from "#db/read.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { questionRecord, questionRule } from "#shared/records/questions.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";
import { expectRecordDelete } from "#test-utils/record-commands.ts";
import { describeRecord } from "#test-utils/record-labels.ts";

const LIMIT = 10_240;

const stored = (displayType: QuestionDisplayType): Question => ({
  answerLevel: "booking",
  assignAll: false,
  displayType: displayType,
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

    expect(questionRule(input, null)).toEqual({
      ok: true,
      value: { ...input, answerLevel: "booking" },
    });
  });

  const LISTING = {
    answerLevel: "listing" as const,
    displayType: "free_text" as const,
    text: "Q",
  };
  const listingLevel = {
    ...stored("free_text"),
    answerLevel: "listing" as const,
  };

  const LEVEL_CASES = [
    {
      input: LISTING,
      kept: LISTING,
      name: "lets a new free-text question ask once for each listing",
      stored: null,
    },
    {
      input: { displayType: "free_text" as const, text: "Q" },
      kept: { ...LISTING, answerLevel: "booking" },
      name: "asks once for the booking when a new question names no level",
      stored: null,
    },
    {
      input: { ...LISTING, displayType: "radio" as const },
      kept: { ...LISTING, answerLevel: "booking", displayType: "radio" },
      name: "keeps a new choice question at one per booking whatever the input says",
      stored: null,
    },
    {
      input: { displayType: "free_text" as const, text: "Q" },
      kept: LISTING,
      name: "keeps the stored level on an edit that names none",
      stored: listingLevel,
    },
    {
      input: LISTING,
      kept: LISTING,
      name: "keeps the stored level on an edit that repeats it",
      stored: listingLevel,
    },
  ];

  for (const { input, kept, name, stored: from } of LEVEL_CASES) {
    test(name, () => {
      expect(questionRule(input, from)).toEqual({ ok: true, value: kept });
    });
  }

  test("refuses an edit that changes the answer level", () => {
    expect(questionRule(LISTING, stored("free_text"))).toEqual({
      error:
        "You cannot change how often a question asks. Add a new question instead.",
      ok: false,
    });
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
      value: {
        answerLevel: "booking",
        assignAll: true,
        displayType: "select",
        text: "Pick",
      },
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
    expect(await readRows(from(tables.answers).pick("id"))).toEqual([]);
  });
});

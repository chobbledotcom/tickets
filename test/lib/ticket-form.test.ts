import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildListingAnswerMap,
  buildListingTextAnswerMap,
  groupListingAnswerSets,
} from "#routes/public/ticket-form.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";

const question = (
  id: number,
  display_type: QuestionWithAnswers["display_type"],
): QuestionWithAnswers => ({
  answers:
    display_type === "free_text"
      ? []
      : [
          {
            active: true,
            id: id * 10,
            question_id: id,
            sort_order: 0,
            text: "Answer",
          },
        ],
  display_type,
  id,
  text: `Question ${id}`,
});

describe("ticket form answer grouping", () => {
  test("saves free-text-only submissions for the matching listing attendee", () => {
    const selectedListingIds = new Set([101]);
    const textMap = buildListingTextAnswerMap(
      [{ questionId: 1, text: "Front row please" }],
      new Map([[1, [101]]]),
      selectedListingIds,
    );

    const grouped = groupListingAnswerSets(
      [{ attendee: { id: 501 }, listing: { id: 101 } }],
      {},
      textMap,
    );

    expect(grouped.get(501)).toEqual({
      answerIds: [],
      textAnswers: [{ questionId: 1, text: "Front row please" }],
    });
  });

  test("scopes text and choice answers to the listings that ask each question", () => {
    const selectedListingIds = new Set([101, 202]);
    const questionListingMap = new Map([
      [1, [101]],
      [2, [202]],
    ]);
    const choiceMap = buildListingAnswerMap(
      [question(1, "radio"), question(2, "free_text")],
      [10],
      questionListingMap,
      selectedListingIds,
    );
    const textMap = buildListingTextAnswerMap(
      [{ questionId: 2, text: "Vegan" }],
      questionListingMap,
      selectedListingIds,
    );

    const grouped = groupListingAnswerSets(
      [
        { attendee: { id: 501 }, listing: { id: 101 } },
        { attendee: { id: 902 }, listing: { id: 202 } },
      ],
      choiceMap,
      textMap,
    );

    expect(grouped.get(501)).toEqual({ answerIds: [10] });
    expect(grouped.get(902)).toEqual({
      answerIds: [],
      textAnswers: [{ questionId: 2, text: "Vegan" }],
    });
  });

  test("applies an assign-all question (absent from the map) to every selected listing", () => {
    const selectedListingIds = new Set([101, 202]);

    // An empty map means the question is assigned to no listing in particular,
    // so it applies to every selected listing.
    const textMap = buildListingTextAnswerMap(
      [{ questionId: 1, text: "Window seat" }],
      new Map(),
      selectedListingIds,
    );

    expect(textMap).toEqual({
      "101": [{ questionId: 1, text: "Window seat" }],
      "202": [{ questionId: 1, text: "Window seat" }],
    });
  });

  test("deduplicates assign-all text answers by question for one attendee", () => {
    const selectedListingIds = new Set([101, 202]);
    const textMap = buildListingTextAnswerMap(
      [{ questionId: 1, text: "Window seat" }],
      new Map(),
      selectedListingIds,
    );

    const grouped = groupListingAnswerSets(
      [
        { attendee: { id: 501 }, listing: { id: 101 } },
        { attendee: { id: 501 }, listing: { id: 202 } },
      ],
      {},
      textMap,
    );

    expect(grouped.get(501)).toEqual({
      answerIds: [],
      textAnswers: [{ questionId: 1, text: "Window seat" }],
    });
  });

  test("skips an attendee whose listing collected no answers", () => {
    const grouped = groupListingAnswerSets(
      [
        { attendee: { id: 501 }, listing: { id: 101 } },
        { attendee: { id: 902 }, listing: { id: 202 } },
      ],
      { "101": [10] },
      {},
    );

    expect(grouped.get(501)).toEqual({ answerIds: [10] });
    // Listing 202 asked nothing, so its attendee is left out entirely.
    expect(grouped.has(902)).toBe(false);
  });
});

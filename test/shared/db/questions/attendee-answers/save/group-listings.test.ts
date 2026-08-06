import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { groupListingAnswerSets } from "#shared/db/questions/attendee-answers/save.ts";

test("groups listing choices and keeps the last text for each attendee question", () => {
  const grouped = groupListingAnswerSets(
    [
      { attendee: { id: 10 }, listing: { id: 1 } },
      { attendee: { id: 10 }, listing: { id: 2 } },
      { attendee: { id: 20 }, listing: { id: 3 } },
      { attendee: { id: 30 }, listing: { id: 4 } },
      { attendee: { id: 40 }, listing: { id: 5 } },
    ],
    { "1": [101], "2": [202], "4": [404] },
    {
      "1": [{ questionId: 7, text: "First" }],
      "2": [
        { questionId: 7, text: "Last" },
        { questionId: 8, text: "Other" },
      ],
      "5": [{ questionId: 9, text: "Text only" }],
    },
  );
  expect(grouped).toEqual(
    new Map([
      [
        10,
        {
          answerIds: [101, 202],
          textAnswers: [
            { questionId: 7, text: "Last" },
            { questionId: 8, text: "Other" },
          ],
        },
      ],
      [30, { answerIds: [404] }],
      [
        40,
        { answerIds: [], textAnswers: [{ questionId: 9, text: "Text only" }] },
      ],
    ]),
  );
});

test("uses no answers when listing maps and entries are empty", () => {
  expect(
    groupListingAnswerSets([{ attendee: { id: 10 }, listing: { id: 1 } }], {}),
  ).toEqual(new Map());
  expect(groupListingAnswerSets([], {})).toEqual(new Map());
});

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  questionAnswerLevelError,
  requireQuestionAnswerLevel,
} from "#db/question-types.ts";

test("names each answer level a question can have", () => {
  expect([
    requireQuestionAnswerLevel("booking"),
    requireQuestionAnswerLevel("listing"),
  ]).toEqual(["booking", "listing"]);
});

test("refuses a level that is not on the list", () => {
  expect(() => requireQuestionAnswerLevel("ticket")).toThrow(
    questionAnswerLevelError,
  );
});

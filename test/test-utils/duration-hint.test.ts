import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  reservesHint,
  reservesHintStart,
  sharedStartOfPhrases,
} from "#test-utils/duration-hint.ts";

describe("sharedStartOfPhrases", () => {
  test("keeps the words before the first difference", () => {
    expect(sharedStartOfPhrases("reserves 1 day", "reserves 2 days")).toBe(
      "reserves ",
    );
  });

  test("refuses phrases that share no wording", () => {
    expect(() => sharedStartOfPhrases("1 day", "2 days")).toThrow(
      "share no wording",
    );
  });

  test("refuses phrases sharing only blank space", () => {
    expect(() => sharedStartOfPhrases(" 1 day", " 2 days")).toThrow(
      "share no wording",
    );
  });
});

describe("reservesHintStart", () => {
  test("opens the note for every length of booking", () => {
    expect(reservesHint(3).startsWith(reservesHintStart())).toBe(true);
    expect(reservesHint(1).startsWith(reservesHintStart())).toBe(true);
  });
});

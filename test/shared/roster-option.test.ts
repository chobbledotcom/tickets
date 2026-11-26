import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  matchingPeople,
  SEARCH_MAX_RESULTS,
  SEARCH_MIN_LENGTH,
} from "#shared/roster-option.ts";

/** The saved-list and search-route shape one person carries, for the
 * matcher's tests: only the name matters to the rule. */
const person = (name: string) => ({ name });

describe("the door's shared name search", () => {
  test("takes its minimum and its cap from one declaration", () => {
    expect(SEARCH_MIN_LENGTH).toBe(2);
    expect(SEARCH_MAX_RESULTS).toBe(20);
  });

  test("answers the people whose name holds the text, in name order", () => {
    expect(
      matchingPeople(
        [person("Zoe Archer"), person("Ada Lane"), person("Bea Cole")],
        "a",
      ),
    ).toEqual([person("Ada Lane"), person("Bea Cole"), person("Zoe Archer")]);
  });

  test("ignores the case of both the name and the text", () => {
    expect(matchingPeople([person("Ada Lane")], "ADA")).toEqual([
      person("Ada Lane"),
    ]);
  });

  test("answers at most the cap, taking the first in name order", () => {
    const crowd = Array.from({ length: SEARCH_MAX_RESULTS + 5 }, (_, index) =>
      person(`Filler ${String.fromCharCode(97 + index)}`),
    );
    const found = matchingPeople(crowd, "filler");

    expect(found).toHaveLength(SEARCH_MAX_RESULTS);
    expect(found).toEqual(crowd.slice(0, SEARCH_MAX_RESULTS));
  });

  test("answers nobody when no name holds the text", () => {
    expect(matchingPeople([person("Ada Lane")], "zoe")).toEqual([]);
  });
});

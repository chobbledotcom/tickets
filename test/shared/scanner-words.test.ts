import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { ScannerWordsSchema, wordingOf } from "#shared/scanner-words.ts";
import { PAGE_WORDS } from "#test/ui/client/scanner/words.ts";

const wording = wordingOf(PAGE_WORDS);

describe("scanner words", () => {
  test("fills every hole of a word from its values", () => {
    expect(
      wording.fill("checkedInPartial", {
        listingName: "Ceilidh",
        name: "Ada",
        tickets: 2,
        total: 3,
      }),
    ).toBe("Ada checked in for Ceilidh (2 of 3 tickets)");
    expect(wording.fill("queueCountOther", { count: 0 })).toBe(
      "0 queued check-ins",
    );
  });

  test("counts one ticket and several tickets in the page's words", () => {
    expect(wording.ticketCount(1)).toBe("1 ticket");
    expect(wording.ticketCount(3)).toBe("3 tickets");
  });

  test("reads a word that fills no holes as it stands", () => {
    expect(wording.word("searchButton")).toBe("Search");
  });

  test("refuses a set of words that misses one", () => {
    const { searchButton: _gone, ...rest } = PAGE_WORDS;
    expect(() => v.parse(ScannerWordsSchema, rest)).toThrow();
  });
});

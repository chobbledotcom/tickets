/**
 * Pins the two lookup modes of `expectExcludesAll`: a string haystack is
 * searched by substring, a list by exact match. The string mode is the one
 * page text takes, so the substring rule is what a leaking page trips over.
 */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { expectExcludesAll } from "#test-utils/assertions/absent.ts";

describe("expectExcludesAll", () => {
  test("fails on a substring inside a body of text", () => {
    expect(() => expectExcludesAll("<p>hello world</p>", ["hello"])).toThrow(
      "Expected no occurrence of hello",
    );
  });

  test("passes when the needle is absent from a body of text", () => {
    expectExcludesAll("<p>hello world</p>", ["goodbye"]);
  });

  test("fails when an exact element is present in a list", () => {
    expect(() => expectExcludesAll(["a", "b"], ["a"])).toThrow(
      "Expected no occurrence of a",
    );
  });

  test("passes when the needle is a substring of an element but not the element", () => {
    expectExcludesAll(["hello world", "goodbye"], ["hello"]);
  });
});

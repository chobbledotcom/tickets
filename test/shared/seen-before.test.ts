import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { seenBefore } from "#shared/seen-before.ts";

describe("seenBefore", () => {
  test("returns false for a first key and true for every repeat of it", () => {
    const isRepeat = seenBefore();

    expect(isRepeat("a")).toBe(false);
    expect(isRepeat("b")).toBe(false);
    expect(isRepeat("a")).toBe(true);
    expect(isRepeat("a")).toBe(true);
  });

  test("each tracker starts fresh — one tracker's keys never leak into another", () => {
    const first = seenBefore();
    first("a");

    expect(seenBefore()("a")).toBe(false);
  });
});

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { bindFirst } from "#shared/fp-bind.ts";

describe("bindFirst", () => {
  const join = (first: string, second: string, third: string): string =>
    `${first}-${second}-${third}`;

  test("supplies the first argument now and the rest later", () => {
    expect(bindFirst(join)("a")("b", "c")).toBe("a-b-c");
  });

  test("reuses one bound first argument for several calls", () => {
    const bound = bindFirst(join)("a");
    expect(bound("b", "c")).toBe("a-b-c");
    expect(bound("d", "e")).toBe("a-d-e");
  });
});

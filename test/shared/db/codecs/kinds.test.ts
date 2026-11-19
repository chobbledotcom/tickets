/**
 * Tests for `src/shared/db/codecs/kinds.ts`: each codec kind, both ways.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  asItself,
  blankAsItself,
  type Codec,
  converts,
  json,
  nullable,
  tidied,
  typed,
  yesNo,
} from "#db/codecs/kinds.ts";

/** A codec that marks text, so a test can see which way it ran. */
const marked: Codec<string, string> = {
  decode: (stored) => `decoded ${stored}`,
  encode: (app) => `encoded ${app}`,
};

describe("column codecs", () => {
  test("a yes or no reads 1 as yes and anything else as no", () => {
    expect([yesNo.decode(1, 1), yesNo.decode(0, 1)]).toEqual([true, false]);
    expect([yesNo.encode(true), yesNo.encode(false)]).toEqual([1, 0]);
  });

  test("a nullable codec passes null both ways and runs on a value", () => {
    const codec = nullable(marked);
    expect([codec.decode(null, 1), codec.encode(null)]).toEqual([null, null]);
    expect([codec.decode("a", 1), codec.encode("b")]).toEqual([
      "decoded a",
      "encoded b",
    ]);
  });

  test("blank text stays blank both ways and other text runs", () => {
    const codec = blankAsItself(marked);
    expect([codec.decode("", 1), codec.encode("")]).toEqual(["", ""]);
    expect([codec.decode("a", 1), codec.encode("b")]).toEqual([
      "decoded a",
      "encoded b",
    ]);
  });

  test("a JSON codec checks its schema both ways and names the row", () => {
    const codec = json(v.array(v.string()), "holidays.days");
    expect(codec.decode('["mon"]', 7)).toEqual(["mon"]);
    expect(codec.encode(["tue"])).toBe('["tue"]');
    expect(() => codec.decode("[1]", 7)).toThrow("holidays.days row 7");
  });

  test("a tidied codec tidies a new value and leaves a read alone", () => {
    const codec = tidied(asItself<number>(), (value) => Math.min(value, 9));
    expect([codec.encode(12), codec.decode(12, 1)]).toEqual([9, 12]);
  });

  test("only a codec with code to run converts", () => {
    expect([converts(yesNo), converts(typed<string>())]).toEqual([true, false]);
  });
});

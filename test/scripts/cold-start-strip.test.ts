import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import {
  median,
  stripBase64Payloads,
  stripLongStrings,
  strippedChars,
} from "../../scripts/bench/cold-start/strip-lib.ts";

describe("cold-start bench string stripping", () => {
  test("stripBase64Payloads empties long blobs and keeps short ones", () => {
    const blob = "A".repeat(40);
    const code = `const big=x("${blob}");const small=x("QUJD");`;
    const result = stripBase64Payloads(code, 30);
    expect(result.code).toBe(`const big=x("");const small=x("QUJD");`);
    expect(result.stripped).toEqual([{ lengthChars: 40, startIndex: 12 }]);
    expect(strippedChars(result)).toBe(40);
  });

  test("stripBase64Payloads cannot cross a string boundary", () => {
    // Two short blobs with code between them must not merge into one match
    // even when their combined length passes the threshold.
    const code = `f("${"B".repeat(20)}");g("${"C".repeat(20)}");`;
    const result = stripBase64Payloads(code, 30);
    expect(result.code).toBe(code);
    expect(result.stripped).toEqual([]);
  });

  test("stripLongStrings strips escaped strings but not the code between", () => {
    const long = `line\\n${"y".repeat(30)}`;
    const code = `const a="${long}";const keep=1;const b="${long}";`;
    const result = stripLongStrings(code, 20);
    expect(result.code).toBe(`const a="";const keep=1;const b="";`);
    expect(result.stripped).toEqual([
      { lengthChars: long.length, startIndex: code.indexOf(`"${long}"`) },
      { lengthChars: long.length, startIndex: code.lastIndexOf(`"${long}"`) },
    ]);
  });

  test("stripLongStrings leaves short strings alone", () => {
    const code = `const a="short";`;
    expect(stripLongStrings(code, 20).code).toBe(code);
  });

  test("stripLongStrings never starts a string at another one's closing quote", () => {
    // A short string followed by a long quote-free stretch of code, then
    // another string: a naive regex would match from the first string's
    // CLOSING quote to the second string's opening quote and delete the
    // code in between. The quote-pairing scan must keep it intact.
    const longCode = `const ${"x".repeat(30)}=1;`;
    const code = `const a="short";${longCode}const b="also short";`;
    const result = stripLongStrings(code, 20);
    expect(result.code).toBe(code);
    expect(result.stripped).toEqual([]);
  });

  test("median picks the middle of a sorted copy", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import {
  median,
  stripBase64Payloads,
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

  test("stripBase64Payloads ignores base64-length runs inside regex literals", () => {
    // A regex literal with double quotes must not be mistaken for a string
    // boundary — the charset-restricted match cannot span `/`, `(` or `=1;`.
    const blob = "D".repeat(40);
    const code = `const re=/viewBox="([^"]+)"/;const big=x("${blob}");`;
    const result = stripBase64Payloads(code, 30);
    expect(result.code).toBe(`const re=/viewBox="([^"]+)"/;const big=x("");`);
    expect(result.stripped).toEqual([
      { lengthChars: 40, startIndex: code.indexOf(`"${blob}"`) },
    ]);
  });

  test("median picks the middle of a sorted copy", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

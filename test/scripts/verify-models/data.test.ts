import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { tlaModule, tlaRecords } from "#scripts/verify-models/data.ts";
import { records } from "#test-utils/tla-data.ts";

const amountFields = { amount: "Int", held: "Bool", label: "Str" } as const;

describe("TLA integer facts", () => {
  test("rejects values that the integer model cannot represent exactly", () => {
    for (const amount of [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        tlaRecords("Amounts", amountFields, [
          { amount, held: false, label: "bad" },
        ]),
      ).toThrow(/Amounts\[0\]\.amount/);
    }
  });

  test("preserves signed safe integers and the other field types", () => {
    const expected = [
      { amount: Number.MIN_SAFE_INTEGER, held: true, label: "debt" },
      { amount: 0, held: false, label: "clear" },
      { amount: Number.MAX_SAFE_INTEGER, held: true, label: "credit" },
    ];
    const data = tlaModule("AmountsData", [
      tlaRecords("Amounts", amountFields, expected),
    ]);
    expect(records(data, "Amounts")).toEqual(expected);
  });

  test("preserves sequence order and duplicate rows but keeps set identity", () => {
    const first = { amount: 3, held: false, label: "first" };
    const second = { amount: 1, held: true, label: "second" };
    const rows = [second, first, second];
    for (const collection of ["Set", "Seq"] as const) {
      const data = tlaModule("AmountsData", [
        tlaRecords("Amounts", amountFields, rows, collection),
      ]);
      expect(records(data, "Amounts", collection)).toEqual(
        collection === "Set" ? [second, first] : rows,
      );
    }
  });
});

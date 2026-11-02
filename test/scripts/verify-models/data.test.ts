import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  modelRecords,
  quintModule,
  tlaModule,
} from "#scripts/verify-models/data.ts";
import { quintRecords as readQuintRecords } from "#test-utils/quint-data.ts";
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
        modelRecords(
          "Amounts",
          amountFields,
          [{ amount, held: false, label: "bad" }],
          "tla",
        ),
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
      modelRecords("Amounts", amountFields, expected, "tla"),
    ]);
    expect(records(data, "Amounts")).toEqual(expected);
  });
});

describe("Quint fact modules", () => {
  test("writes a typed record set that the fact reader reads back", () => {
    const expected = [
      { amount: Number.MIN_SAFE_INTEGER, held: true, label: "debt" },
      { amount: 0, held: false, label: "clear" },
    ];
    const data = quintModule("AmountsData", [
      modelRecords("Amounts", amountFields, expected, "quint", "Amount"),
    ]);
    expect(data).toContain(
      "type Amount = { amount: int, held: bool, label: str }",
    );
    expect(readQuintRecords(data, "Amounts")).toEqual(expected);
  });

  test("rejects values that the Quint integer model cannot represent", () => {
    for (const amount of [1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        modelRecords(
          "Amounts",
          amountFields,
          [{ amount, held: false, label: "bad" }],
          "quint",
          "Amount",
        ),
      ).toThrow(/Amounts\[0\]\.amount/);
    }
  });

  test("writes the Quint module header and closing brace", () => {
    expect(
      quintModule("Laws", ["pure val value: int = 1", "pure val other = 2"]),
    ).toBe("module Laws {\npure val value: int = 1\n\npure val other = 2\n}\n");
  });
});

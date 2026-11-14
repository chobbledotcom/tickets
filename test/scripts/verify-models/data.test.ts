import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  tlaModule,
  tlaRecords,
  tlaStringSet,
} from "#scripts/verify-models/data.ts";
import {
  memberPages,
  members,
  recordPages,
  records,
} from "#test-utils/tla-data.ts";

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

  test("preserves empty sets, distinct identities and escaped field values", () => {
    const first = {
      amount: 1,
      held: false,
      label: 'AmountsRecord0, "quoted"\\nnext',
    };
    const second = { ...first, label: "separate payment" };
    const data = tlaModule("AmountsData", [
      tlaRecords("Amounts", amountFields, [
        first,
        { amount: first.amount, held: first.held, label: first.label },
        second,
      ]),
      tlaRecords("Empty", amountFields, []),
    ]);
    expect(records(data, "Amounts")).toEqual([first, second]);
    expect(records(data, "Empty")).toEqual([]);
    expect(recordPages(data, "Amounts").flat()).toEqual([first, second]);
    expect(recordPages(data, "Empty")).toEqual([]);
    expect(data).toContain("EmptyIndices == 1..0");
    expect(data).toContain("AmountsCount == 2");
  });

  test("indexes every one of 600 distinct facts without changing set semantics", () => {
    const expected = Array.from({ length: 600 }, (_, index) => ({
      amount: index % 3,
      held: index % 2 === 0,
      label: `booking-${index}`,
    }));
    const data = tlaModule("AmountsData", [
      tlaRecords("Amounts", amountFields, [
        ...expected,
        expected[0]!,
        expected[599]!,
      ]),
    ]);
    const pages = recordPages(data, "Amounts");
    expect(records(data, "Amounts")).toEqual(expected);
    expect(pages.flat()).toEqual(expected);
    expect(pages.map((page) => page.length)).toEqual([
      ...Array.from({ length: 18 }, () => 32),
      24,
    ]);
    expect(data).toContain("AmountsIndices == 1..600");
    expect(data).toContain("AmountsCount == 600");
    expect(data).toContain(
      "AmountsAt(index) == AmountsPages[((index - 1) \\div 32) + 1][((index - 1) % 32) + 1]",
    );
  });

  test("indexes independent expected identities without changing their string set", () => {
    const identities = Array.from(
      { length: 600 },
      (_, index) => `row-${index}: << "quoted" >>\\nnext`,
    );
    const data = tlaModule("IdentitiesData", [
      tlaStringSet("Identities", [...identities, identities[0]!]),
      tlaStringSet("Empty", []),
    ]);
    expect([...new Set(members(data, "Identities"))]).toEqual(identities);
    expect(memberPages(data, "Identities").flat()).toEqual(identities);
    expect(data).toContain("IdentitiesCount == 600");
    expect(memberPages(data, "Empty")).toEqual([]);
    expect(data).toContain("EmptyIndices == 1..0");
  });
});

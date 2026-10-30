/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  corruptAllocationData,
  largestRemainderSplitData,
  largestRemainderSplitModelData,
  type SplitFact,
  splitCases,
  splitModel,
} from "#scripts/verify-models/largest-remainder-split.ts";
import { largestRemainderAllocation } from "#shared/largest-remainder.ts";
import { records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

const FACT_FLAGS = ["conserved", "bounded", "nonNegative", "capped"] as const;

/** Every representative case, keyed by its sample tag: the weights, the
 *  amount and the exact allocation the production function must produce. */
const EXPECTED: readonly (readonly [string, string, string, string])[] = [
  ["zero amount", "[10,20]", "0", "[0,0]"],
  ["negative amount above minus one", "[10,20]", "-0.5", "[0,0]"],
  ["all weights zero", "[0,0]", "10", "[0,0]"],
  [
    "exact split with index tie-breaks",
    "[1000,1000,1000]",
    "100",
    "[34,33,33]",
  ],
  ["leftovers to the largest fractional remainder", "[1,1,5]", "2", "[0,0,2]"],
  ["biggest fraction, not biggest floor", "[3,1]", "3", "[2,1]"],
  ["tie-break values decide a tie", "[3,5,2]", "5", "[2,2,1]"],
  ["small positive total", "[0.4,0.4]", "1", "[1,0]"],
  [
    "deposit capped at the unit prices",
    "[1000,1000,1000]",
    "2500",
    "[834,833,833]",
  ],
  ["a part at its cap receives no more", "[500,1000]", "2000", "[666,1334]"],
  [
    "whole-money remainders beyond safe multiplication",
    "[2500000000000005,2500000000000005,2500000000000005,2,3]",
    "7125000000000019",
    "[2375000000000005,2375000000000005,2375000000000004,2,3]",
  ],
];

const factByTag = (facts: readonly SplitFact[], tag: string): SplitFact => {
  const fact = facts.find((candidate) => candidate.sampleTag === tag);
  if (!fact) throw new Error(`Missing split fact ${tag}`);
  return { ...fact };
};

describe("largest remainder split proof data", () => {
  test("derives every fact from the production function", async () => {
    const facts = await splitModel();
    expect(facts).toHaveLength(EXPECTED.length);
    for (const [tag, weights, amount, allocations] of EXPECTED) {
      const fact = factByTag(facts, tag);
      expect(fact.weights).toBe(weights);
      expect(fact.amount).toBe(amount);
      expect(fact.allocations).toBe(allocations);
    }
  });

  test("marks every generated fact exact", async () => {
    const data = await largestRemainderSplitModelData();
    const facts = records(data, "SplitFacts");
    expect(facts).toHaveLength(EXPECTED.length);
    for (const fact of facts) {
      for (const flag of FACT_FLAGS) {
        expect(fact[flag]).toBe(true);
      }
    }
  });

  test("the exact allocations match the production function's own results", async () => {
    const facts = await splitModel();
    for (const sample of splitCases) {
      const fact = factByTag(facts, sample.sampleTag);
      expect(JSON.parse(fact.allocations)).toEqual(
        largestRemainderAllocation(
          sample.weights,
          sample.amount,
          sample.options,
        ),
      );
    }
  });

  test("retains an unconserved allocation as a false fact", async () => {
    const facts = splitModel((weights, amount) =>
      amount === 100
        ? [34, 34, 33]
        : largestRemainderAllocation(weights, amount),
    );
    const fact = factByTag(facts, "exact split with index tie-breaks");
    expect(JSON.parse(fact.allocations)).toEqual([34, 34, 33]);
    expect(fact.conserved).toBe(false);
    expect(facts.some((candidate) => candidate.conserved === false)).toBe(true);
  });

  test("retains an unbounded allocation as a false fact", async () => {
    const facts = splitModel((weights, amount) =>
      amount === 100
        ? [35, 33, 32]
        : largestRemainderAllocation(weights, amount),
    );
    expect(facts.some((candidate) => candidate.bounded === false)).toBe(true);
    expect(facts.some((candidate) => candidate.conserved === false)).toBe(
      false,
    );
  });

  test("retains a negative allocation as a false fact", async () => {
    const facts = splitModel((weights, amount) =>
      amount === 100
        ? [-1, 51, 50]
        : largestRemainderAllocation(weights, amount),
    );
    expect(facts.some((candidate) => candidate.nonNegative === false)).toBe(
      true,
    );
  });

  test("retains an over-cap allocation as a false fact", async () => {
    const facts = splitModel((weights, amount) =>
      amount === 2500
        ? [1200, 800, 500]
        : largestRemainderAllocation(weights, amount),
    );
    expect(facts.some((candidate) => candidate.capped === false)).toBe(true);
  });

  test("detects a split that ignores its cap guard", async () => {
    const facts = splitModel((weights, amount) =>
      largestRemainderAllocation(weights, amount),
    );
    const overCap = facts.filter((fact) => fact.capped === false);
    expect(overCap.map((fact) => fact.sampleTag)).toEqual([
      "a part at its cap receives no more",
    ]);
    expect(overCap[0]?.conserved).toBe(true);
  });

  test("corrupt data flips exactly one fact's conservation flag", async () => {
    const honest = records(
      await largestRemainderSplitModelData(),
      "SplitFacts",
    );
    const corrupted = records(await corruptAllocationData(), "SplitFacts");
    expect(corrupted).toHaveLength(honest.length);
    const changed = honest.flatMap((fact, index) => {
      const after = corrupted[index];
      if (after === undefined || after.conserved === fact.conserved) return [];
      return [{ after, before: fact }];
    });
    expect(changed).toHaveLength(1);
    expect(changed[0]?.before).toMatchObject({
      allocations: "[34,33,33]",
      amount: "100",
      conserved: true,
      weights: "[1000,1000,1000]",
    });
    expect(changed[0]?.after.conserved).toBe(false);
  });

  test("the data module carries the fact table under its own name", async () => {
    const data = largestRemainderSplitData(await splitModel());
    expect(data).toContain("MODULE LargestRemainderSplitData");
    expect(data).toContain("SplitFacts ==");
  });
});

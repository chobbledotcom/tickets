/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sum } from "#fp";
import {
  corruptSplitData,
  largestRemainderSplitModelData,
  type SplitPartFact,
  splitCases,
  splitFacts,
} from "#scripts/verify-models/largest-remainder-split.ts";
import { largestRemainderAllocation } from "#shared/largest-remainder.ts";
import { records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

type DataRecord = Record<string, string | boolean | number>;

/** The case that runs no split and the case with a fractional amount stay
 *  out of the integer model; the other nine cases carry its facts. */
const UNMODELLED_TAGS = ["negative amount above minus one"] as const;

const caseByTag = (tag: string) => {
  const sample = splitCases.find((candidate) => candidate.sampleTag === tag);
  if (!sample) throw new Error(`Missing split case ${tag}`);
  return sample;
};

const partFactsOf = (
  partFacts: readonly SplitPartFact[],
  tag: string,
): SplitPartFact[] => partFacts.filter((partFact) => partFact.caseTag === tag);

const recordsOf = (data: string, name: string): DataRecord[] =>
  records(data, name) as DataRecord[];

/** Every case's exact shape and the exact allocation the production function
 *  must produce for it. The pin keeps the representative table honest: a
 *  changed weight, amount, tag or answer stops the proof data here. */
const EXACT_CASES: readonly (readonly [
  string,
  readonly number[],
  number,
  readonly number[],
])[] = [
  ["zero amount", [10, 20], 0, [0, 0]],
  ["negative amount above minus one", [10, 20], -0.5, [0, 0]],
  ["all weights zero", [0, 0], 10, [0, 0]],
  ["exact split with index tie-breaks", [1000, 1000, 1000], 100, [34, 33, 33]],
  ["leftovers to the largest fractional remainder", [1, 1, 5], 2, [0, 0, 2]],
  ["biggest fraction, not biggest floor", [3, 1], 3, [2, 1]],
  ["tie-break values decide a tie", [3, 5, 2], 5, [2, 2, 1]],
  ["small positive total", [0.4, 0.4], 1, [1, 0]],
  [
    "deposit capped at the unit prices",
    [1000, 1000, 1000],
    2500,
    [834, 833, 833],
  ],
  ["a part at its cap receives no more", [500, 1000], 2000, [666, 1334]],
  ["reservation deposit across capacities", [4, 1, 1], 5, [3, 1, 1]],
  [
    "tax across lines and modifiers",
    [1200, 800, 450, 150, 75, 25],
    267,
    [119, 79, 45, 15, 7, 2],
  ],
  [
    "whole-money remainders beyond safe multiplication",
    [2500000000000005, 2500000000000005, 2500000000000005, 2, 3],
    7125000000000019,
    [2375000000000005, 2375000000000005, 2375000000000004, 2, 3],
  ],
];

/** The caps each capped case carries, by tag. */
const EXACT_CAPS: Readonly<Record<string, readonly number[]>> = {
  "a part at its cap receives no more": [666, 1334],
  "deposit capped at the unit prices": [1000, 1000, 1000],
};

/** The tie-break values a case's own option returns, per part. */
const tieBreakerOf = (tag: string): (number | undefined)[] =>
  caseByTag(tag).weights.map((_, index) =>
    caseByTag(tag).options?.tieBreaker?.(index),
  );

/** The verdicts a case's own guard returns for the derived floors. */
const guardVerdictsOf = (tag: string): boolean[] => {
  const sample = caseByTag(tag);
  const { partFacts } = splitFacts();
  return partFactsOf(partFacts, tag).map(
    (part) =>
      sample.options?.canReceive?.(part.partIndex - 1, part.floor) ?? true,
  );
};

describe("largest remainder split proof data", () => {
  test("carries one part fact per part of every modelled case", () => {
    const { caseFacts, partFacts } = splitFacts();
    const modelled = splitCases.filter((sample) =>
      Number.isInteger(sample.amount),
    );
    expect(caseFacts.map((caseFact) => caseFact.caseTag)).toEqual(
      modelled.map((sample) => sample.sampleTag),
    );
    for (const sample of modelled) {
      const parts = partFactsOf(partFacts, sample.sampleTag);
      expect(parts.map((part) => part.partIndex)).toEqual(
        sample.weights.map((_, index) => index + 1),
      );
    }
  });

  test("leaves the fractional-amount case to the direct tests", () => {
    const { caseFacts } = splitFacts();
    for (const tag of UNMODELLED_TAGS) {
      expect(caseFacts.some((caseFact) => caseFact.caseTag === tag)).toBe(
        false,
      );
      expect(splitCases.some((sample) => sample.sampleTag === tag)).toBe(true);
    }
  });

  test("carries each part's proportional floor and cap", () => {
    const { partFacts } = splitFacts();
    for (const part of partFacts) {
      const sample = caseByTag(part.caseTag);
      const runs = sample.amount > 0 && sum(sample.weights) > 0;
      const weight = sample.weights[part.partIndex - 1]!;
      const expectedFloor = runs
        ? Math.floor((sample.amount * weight) / sum(sample.weights))
        : 0;
      expect(part.floor).toBe(expectedFloor);
      expect(part.cap).toBe(sample.caps?.[part.partIndex - 1] ?? 0);
    }
  });

  test("marks eligibility with the case's own guard", () => {
    const { partFacts } = splitFacts();
    for (const part of partFacts) {
      const sample = caseByTag(part.caseTag);
      const runs = sample.amount > 0 && sum(sample.weights) > 0;
      if (!runs) {
        // A case that runs no split awards nothing.
        expect(part.eligible).toBe(false);
        continue;
      }
      const floor = part.floor;
      const guarded = sample.options?.canReceive ?? (() => true);
      expect(part.eligible).toBe(guarded(part.partIndex - 1, floor));
    }
  });

  test("the guard leaves room for every owed unit", () => {
    const { caseFacts, partFacts } = splitFacts();
    for (const caseFact of caseFacts) {
      const eligibleCount = partFactsOf(partFacts, caseFact.caseTag).filter(
        (p) => p.eligible,
      ).length;
      expect(eligibleCount).toBeGreaterThanOrEqual(caseFact.leftover);
    }
  });

  test("every case's accounting balances", () => {
    const { caseFacts, partFacts } = splitFacts();
    for (const caseFact of caseFacts) {
      const sample = caseByTag(caseFact.caseTag);
      const runs = sample.amount > 0 && sum(sample.weights) > 0;
      const owed = runs
        ? sample.amount -
          sum(partFactsOf(partFacts, caseFact.caseTag).map((p) => p.floor))
        : 0;
      expect(caseFact.leftover).toBe(owed);
      expect(caseFact.leftover).toBeLessThan(sample.weights.length);
    }
  });

  test("the production result is reachable in the award loop", () => {
    const { caseFacts, partFacts } = splitFacts();
    for (const caseFact of caseFacts) {
      const sample = caseByTag(caseFact.caseTag);
      const output = largestRemainderAllocation(
        sample.weights,
        sample.amount,
        sample.options ?? {},
      );
      const parts = partFactsOf(partFacts, caseFact.caseTag);
      let bumps = 0;
      for (const [index, allocation] of output.entries()) {
        const part = parts[index]!;
        const extra = allocation - part.floor;
        expect([0, 1]).toContain(extra);
        if (extra === 1) {
          bumps += 1;
          expect(part.eligible).toBe(true);
        }
      }
      expect(bumps).toBe(caseFact.leftover);
    }
  });

  test("a part at its cap receives no more", () => {
    const { partFacts } = splitFacts();
    const sample = caseByTag("a part at its cap receives no more");
    const parts = partFactsOf(partFacts, sample.sampleTag);
    const atCap = parts.find((part) => part.cap === part.floor)!;
    const filler = parts.find((part) => part.cap !== part.floor)!;
    expect(atCap.eligible).toBe(false);
    expect(filler.eligible).toBe(true);
    expect(filler.floor + 1).toBe(filler.cap);
  });

  test("corrupting the guard awards past a cap", async () => {
    const data = await corruptSplitData("cap guard");
    const parts = recordsOf(data, "SplitParts");
    const cases = recordsOf(data, "SplitCases");
    const flipped = parts.filter(
      (part) =>
        part.caseTag === "a part at its cap receives no more" &&
        part.eligible === true &&
        (part.floor as number) + 1 > (part.cap as number),
    );
    expect(flipped).toHaveLength(1);
    expect(
      cases.some(
        (caseFact) =>
          caseFact.caseTag === "a part at its cap receives no more" &&
          caseFact.capped === true,
      ),
    ).toBe(true);
  });

  test("corrupting the accounting strands an owed unit", async () => {
    const data = await corruptSplitData("unconserved accounting");
    const cases = recordsOf(data, "SplitCases");
    const parts = recordsOf(data, "SplitParts");
    const victim = cases.find(
      (caseFact) => caseFact.caseTag === "a part at its cap receives no more",
    )!;
    const eligibleCount = parts.filter(
      (part) => part.caseTag === victim.caseTag && part.eligible === true,
    ).length;
    expect(victim.leftover).toBeGreaterThan(eligibleCount);
  });

  test("throws when the case to corrupt is missing", async () => {
    await expect(
      corruptSplitData("unconserved accounting", {
        caseFacts: [],
        partFacts: [],
      }),
    ).rejects.toThrow(
      'The split model holds no "a part at its cap receives no more" case. There is no case to corrupt.',
    );
  });

  test("throws when the part to corrupt is missing", async () => {
    const { caseFacts } = splitFacts();
    await expect(
      corruptSplitData("cap guard", { caseFacts, partFacts: [] }),
    ).rejects.toThrow(
      'The split model holds no part at its cap for "a part at its cap receives no more". There is no part to corrupt.',
    );
  });

  test("every case carries its exact shape and production answer", () => {
    expect(splitCases.map((sample) => sample.sampleTag)).toEqual(
      EXACT_CASES.map(([tag]) => tag),
    );
    for (const [tag, weights, amount, output] of EXACT_CASES) {
      const sample = caseByTag(tag);
      expect(sample.weights).toEqual(weights);
      expect(sample.amount).toBe(amount);
      expect(sample.caps ?? null).toEqual(EXACT_CAPS[tag] ?? null);
      expect(
        largestRemainderAllocation(
          sample.weights,
          sample.amount,
          sample.options ?? {},
        ),
      ).toEqual(output);
    }
    // The guard and tie-break decisions are facts of their own: the proof
    // pins them per index, so a changed constant stops here.
    expect(tieBreakerOf("tie-break values decide a tie")).toEqual([-3, 2, -1]);
    expect(tieBreakerOf("reservation deposit across capacities")).toEqual([
      2, 0, 1,
    ]);
    expect(guardVerdictsOf("a part at its cap receives no more")).toEqual([
      false,
      true,
    ]);
    expect(guardVerdictsOf("reservation deposit across capacities")).toEqual([
      true,
      true,
      true,
    ]);
  });

  test("the cap corruption needs a part at its cap to flip", async () => {
    const { caseFacts } = splitFacts();
    const victimCaseTag = "a part at its cap receives no more";
    // The case holds an already-eligible part and a part below its cap, so
    // no part of it may be flipped.
    const partFacts: SplitPartFact[] = [
      {
        cap: 5,
        caseTag: victimCaseTag,
        eligible: true,
        floor: 5,
        partIndex: 1,
      },
      {
        cap: 9,
        caseTag: victimCaseTag,
        eligible: false,
        floor: 4,
        partIndex: 2,
      },
    ];
    await expect(
      corruptSplitData("cap guard", { caseFacts, partFacts }),
    ).rejects.toThrow(
      'The split model holds no part at its cap for "a part at its cap receives no more". There is no part to corrupt.',
    );
  });

  test("the data module carries the fact tables under their own names", async () => {
    const data = await largestRemainderSplitModelData();
    expect(data).toContain("MODULE LargestRemainderSplitData");
    expect(data).toContain("SplitCases ==");
    expect(data).toContain("SplitParts ==");
  });
});

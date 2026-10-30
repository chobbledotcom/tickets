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
      } else if (sample.caps === undefined) {
        // A case without a guard lets every part receive.
        expect(part.eligible).toBe(true);
      } else if (part.eligible) {
        // The honesty relation the model checks: an eligible part of a
        // capped case has room under its cap for the one extra unit.
        expect(part.floor + 1).toBeLessThanOrEqual(part.cap);
      }
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

  test("the data module carries the fact tables under their own names", async () => {
    const data = await largestRemainderSplitModelData();
    expect(data).toContain("MODULE LargestRemainderSplitData");
    expect(data).toContain("SplitCases ==");
    expect(data).toContain("SplitParts ==");
  });
});

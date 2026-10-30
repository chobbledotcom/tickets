/* jscpd:ignore-start -- imports */
import { sum } from "#fp";
import {
  type ModelDataSource,
  type TlaFact,
  tlaModule,
  tlaRecords,
} from "#scripts/verify-models/data.ts";
import { largestRemainderAllocation } from "#shared/largest-remainder.ts";

/* jscpd:ignore-end */

type SplitOptions = {
  readonly canReceive?: (index: number, floor: number) => boolean;
  readonly tieBreaker?: (index: number) => number;
};

/** The unit prices of the deposit case. */
const unitPriceCaps = [1000, 1000, 1000] as const;

/** The caps of the binding case: one floor sits at its cap, so the guard must
 *  turn the bump away, and the other part fills to its exact cap. */
const bindingCaps = [666, 1334] as const;

/** A part whose floor sits below its cap can receive one more unit. */
const canReceiveBelowCap =
  (caps: readonly number[]) =>
  (index: number, floor: number): boolean =>
    floor < caps[index]!;

/** One representative allocation. `caps` names the per-unit upper bound the
 *  split must respect when a `canReceive` option guards it. */
type SplitCase = {
  readonly amount: number;
  readonly caps: readonly number[] | undefined;
  readonly options?: SplitOptions;
  readonly sampleTag: string;
  readonly weights: readonly number[];
};

/** The representative problems the proof covers: the money-path shapes plus
 *  the edge cases the direct tests pin. Every allocation runs through the
 *  production function; no stored answer supplies the proof. */
export const splitCases: readonly SplitCase[] = [
  {
    amount: 0,
    caps: undefined,
    sampleTag: "zero amount",
    weights: [10, 20],
  },
  {
    amount: -0.5,
    caps: undefined,
    sampleTag: "negative amount above minus one",
    weights: [10, 20],
  },
  {
    amount: 10,
    caps: undefined,
    sampleTag: "all weights zero",
    weights: [0, 0],
  },
  {
    amount: 100,
    caps: undefined,
    sampleTag: "exact split with index tie-breaks",
    weights: [1000, 1000, 1000],
  },
  {
    amount: 2,
    caps: undefined,
    sampleTag: "leftovers to the largest fractional remainder",
    weights: [1, 1, 5],
  },
  {
    amount: 3,
    caps: undefined,
    sampleTag: "biggest fraction, not biggest floor",
    weights: [3, 1],
  },
  {
    amount: 5,
    caps: undefined,
    options: { tieBreaker: (index) => [-3, 2, -1][index]! },
    sampleTag: "tie-break values decide a tie",
    weights: [3, 5, 2],
  },
  {
    amount: 1,
    caps: undefined,
    sampleTag: "small positive total",
    weights: [0.4, 0.4],
  },
  {
    amount: 2500,
    caps: unitPriceCaps,
    options: { canReceive: canReceiveBelowCap(unitPriceCaps) },
    sampleTag: "deposit capped at the unit prices",
    weights: [1000, 1000, 1000],
  },
  {
    amount: 2000,
    caps: bindingCaps,
    options: { canReceive: canReceiveBelowCap(bindingCaps) },
    sampleTag: "a part at its cap receives no more",
    weights: [500, 1000],
  },
  {
    amount: 7125000000000019,
    caps: undefined,
    sampleTag: "whole-money remainders beyond safe multiplication",
    weights: [2500000000000005, 2500000000000005, 2500000000000005, 2, 3],
  },
];

/** The independent safety flags the proof asserts. Each one is recomputed from
 *  the raw weights and the produced parts, never from the production's
 *  internal floors, so a wrong floor or a wrong bump count shows up here. */
type SplitFlags = {
  readonly bounded: boolean;
  readonly capped: boolean;
  readonly conserved: boolean;
  readonly nonNegative: boolean;
};

const nonNegative = (allocations: readonly number[]): boolean =>
  allocations.every((allocation) => allocation >= 0);

/** A running split conserves the amount: the parts sum to it exactly. When the
 *  amount or the weight total is not positive, production allocates nothing,
 *  so there is no split to conserve and no cap to exceed. */
const flagsOf = (
  weights: readonly number[],
  amount: number,
  allocations: readonly number[],
  caps: readonly number[] | undefined,
): SplitFlags => {
  const total = sum(weights);
  const splitRuns = amount > 0 && total > 0;
  return {
    bounded: splitRuns
      ? allocations.every((allocation, index) => {
          const floor = Math.floor((amount * weights[index]!) / total);
          return allocation >= floor && allocation <= floor + 1;
        })
      : nonNegative(allocations) && sum(allocations) === 0,
    capped:
      caps === undefined
        ? true
        : allocations.every((allocation, index) => allocation <= caps[index]!),
    conserved: splitRuns ? sum(allocations) === amount : true,
    nonNegative: nonNegative(allocations),
  };
};

const splitFields = {
  allocations: "Str",
  amount: "Str",
  bounded: "Bool",
  capped: "Bool",
  conserved: "Bool",
  nonNegative: "Bool",
  sampleTag: "Str",
  weights: "Str",
} as const;

export type SplitFact = TlaFact<typeof splitFields>;

/** Every representative allocation and its independent safety flags. The
 *  allocation function is injectable so the tests can prove the flags stay
 *  visible when production returns an unsafe result. */
export const splitModel = (
  allocate: typeof largestRemainderAllocation = largestRemainderAllocation,
): SplitFact[] =>
  splitCases.map((sample) => {
    const allocations = allocate(sample.weights, sample.amount, sample.options);
    const flags = flagsOf(
      sample.weights,
      sample.amount,
      allocations,
      sample.caps,
    );
    return {
      allocations: JSON.stringify(allocations),
      amount: JSON.stringify(sample.amount),
      ...flags,
      sampleTag: sample.sampleTag,
      weights: JSON.stringify([...sample.weights]),
    };
  });

export const largestRemainderSplitData = (
  facts: readonly SplitFact[],
): string =>
  tlaModule("LargestRemainderSplitData", [
    tlaRecords("SplitFacts", splitFields, facts),
  ]);

/** The generated checker data. Every allocation comes from the production
 *  function; no stored copy supplies the proof. */
export const largestRemainderSplitModelData: ModelDataSource = async () =>
  largestRemainderSplitData(splitModel());

/** The negative control: one running split whose parts do not conserve the
 *  amount. The checker must reject it, or the clean verdicts prove nothing.
 *  The facts are injectable so the tests can reach the missing-fact throw. */
export const corruptAllocationData = async (
  facts: readonly SplitFact[] = splitModel(),
): Promise<string> => {
  const victimTag = "exact split with index tie-breaks";
  if (!facts.some((fact) => fact.sampleTag === victimTag)) {
    throw new Error(
      `The split model holds no "${victimTag}" fact. There is no fact to corrupt.`,
    );
  }
  return largestRemainderSplitData(
    facts.map((fact) =>
      fact.sampleTag === victimTag ? { ...fact, conserved: false } : fact,
    ),
  );
};

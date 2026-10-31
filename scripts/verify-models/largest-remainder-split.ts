/* jscpd:ignore-start -- imports */
import { sum } from "#fp";
import {
  corruptOneFact,
  type ModelDataSource,
  type TlaFact,
  tlaRecordModuleFor,
} from "#scripts/verify-models/data.ts";

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

/** The reservation deposit case: the caller allocates a deposit across price
 *  tiers by capacity, and a part may receive only while its floor sits below
 *  its own capacity. The tie-break keeps the caller's original order. */
const reservationCapacities = [4, 1, 1] as const;
const reservationOriginalIndexes = [2, 0, 1] as const;

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
 *  the edge cases the direct tests pin. The tests run every case through the
 *  production function; the facts below carry no answer. */
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
    amount: 5,
    caps: undefined,
    options: {
      canReceive: (index, floor) => floor < reservationCapacities[index]!,
      tieBreaker: (index) => reservationOriginalIndexes[index]!,
    },
    sampleTag: "reservation deposit across capacities",
    weights: [...reservationCapacities],
  },
  {
    amount: 267,
    caps: undefined,
    sampleTag: "tax across lines and modifiers",
    weights: [1200, 800, 450, 150, 75, 25],
  },
  {
    amount: 7125000000000019,
    caps: undefined,
    sampleTag: "whole-money remainders beyond safe multiplication",
    weights: [2500000000000005, 2500000000000005, 2500000000000005, 2, 3],
  },
];

/** The cases the integer model covers. A fractional amount has no integer
 *  fact, so that case's behaviour stays with the direct tests. */
const modelCases = (): readonly SplitCase[] =>
  splitCases.filter((sample) => Number.isInteger(sample.amount));

/** Whether the split runs for a case, by production's own rule: a
 *  non-positive amount or a non-positive weight total allocates nothing. */
const splitRuns = (amount: number, weights: readonly number[]): boolean =>
  amount > 0 && sum(weights) > 0;

/** The floor share of every part, from the raw weights alone. */
const floorShares = (amount: number, weights: readonly number[]): number[] =>
  weights.map((weight) =>
    splitRuns(amount, weights)
      ? Math.floor((amount * weight) / sum(weights))
      : 0,
  );

/** The units the award loop still owes after every part took its floor. */
const owedUnits = (
  amount: number,
  weights: readonly number[],
  floors: readonly number[],
): number => (splitRuns(amount, weights) ? amount - sum(floors) : 0);

/** The production guard's verdict for one part: may it receive the one extra
 *  unit? A case without a guard lets every part receive; a case that runs no
 *  split awards nothing. */
const eligibleFor = (sample: SplitCase, floors: readonly number[]): boolean[] =>
  sample.weights.map((_, index) =>
    splitRuns(sample.amount, sample.weights)
      ? (sample.options?.canReceive ?? (() => true))(index, floors[index]!)
      : false,
  );

/** The cap the checker compares against, 0 when the case caps nothing. */
const capOf = (sample: SplitCase, index: number): number =>
  sample.caps?.[index] ?? 0;

/** One case's accounting for the checker: which case it is, whether its parts
 *  carry caps, and how many units the award loop owes. */
export const splitCaseFields = {
  capped: "Bool",
  caseTag: "Str",
  leftover: "Int",
} as const;

/** One part's facts for the checker: its floor share, its cap, and the
 *  production guard's verdict. */
export const splitPartFields = {
  cap: "Int",
  caseTag: "Str",
  eligible: "Bool",
  floor: "Int",
  partIndex: "Int",
} as const;

export type SplitCaseFact = TlaFact<typeof splitCaseFields>;
export type SplitPartFact = TlaFact<typeof splitPartFields>;

export type SplitFacts = {
  readonly caseFacts: readonly SplitCaseFact[];
  readonly partFacts: readonly SplitPartFact[];
};

/** The checker facts: one per case and one per part of every case. Every
 *  number comes from the raw weights through the oracles above. */
export const splitFacts = (): SplitFacts => {
  const caseFacts: SplitCaseFact[] = [];
  const partFacts: SplitPartFact[] = [];
  for (const sample of modelCases()) {
    const floors = floorShares(sample.amount, sample.weights);
    const eligible = eligibleFor(sample, floors);
    caseFacts.push({
      capped: sample.caps !== undefined,
      caseTag: sample.sampleTag,
      leftover: owedUnits(sample.amount, sample.weights, floors),
    });
    for (const [index, floor] of floors.entries()) {
      partFacts.push({
        cap: capOf(sample, index),
        caseTag: sample.sampleTag,
        eligible: eligible[index]!,
        floor,
        partIndex: index + 1,
      });
    }
  }
  return { caseFacts, partFacts };
};

export const largestRemainderSplitData = tlaRecordModuleFor(
  "LargestRemainderSplitData",
  ["SplitCases", splitCaseFields],
  ["SplitParts", splitPartFields],
);

/** The generated checker data for the clean proof. */
export const largestRemainderSplitModelData: ModelDataSource = async () => {
  const { caseFacts, partFacts } = splitFacts();
  return largestRemainderSplitData(caseFacts, partFacts);
};

/** The failure modes the checker must reject. Each one corrupts one fact of
 *  the clean proof data. */
type Corruption = "cap guard" | "unconserved accounting";

/** The case whose owed units one corruption inflates: the guard covers
 *  exactly one award there, so one extra owed unit strands the loop. */
const accountingVictimTag = "a part at its cap receives no more";

/** The part whose guard verdict the other corruption flips: a part that sits
 *  at its cap and must not receive the extra unit. */
const capVictimTag = "a part at its cap receives no more";

const corruptions: Readonly<
  Record<Corruption, (facts: SplitFacts) => SplitFacts>
> = {
  "cap guard": ({ caseFacts, partFacts }) => ({
    caseFacts,
    partFacts: corruptOneFact(
      partFacts,
      (partFact) =>
        partFact.caseTag === capVictimTag &&
        !partFact.eligible &&
        partFact.cap === partFact.floor,
      `The split model holds no part at its cap for "${capVictimTag}". There is no part to corrupt.`,
      (partFact) => ({ ...partFact, eligible: true }),
    ),
  }),
  "unconserved accounting": ({ caseFacts, partFacts }) => ({
    caseFacts: corruptOneFact(
      caseFacts,
      (caseFact) => caseFact.caseTag === accountingVictimTag,
      `The split model holds no "${accountingVictimTag}" case. There is no case to corrupt.`,
      (caseFact) => ({ ...caseFact, leftover: caseFact.leftover + 1 }),
    ),
    partFacts,
  }),
};

/** One corrupted proof-data set. The checker must report a counterexample
 *  for it, or the clean verdicts prove nothing. The facts are injectable so
 *  the tests can reach the missing-fact throw. */
export const corruptSplitData = async (
  corruption: Corruption,
  facts: SplitFacts = splitFacts(),
): Promise<string> => {
  const { caseFacts, partFacts } = corruptions[corruption](facts);
  return largestRemainderSplitData(caseFacts, partFacts);
};

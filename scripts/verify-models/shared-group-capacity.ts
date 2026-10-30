import {
  parentAndChildFitGroup,
  ticketsThatFitInPool,
} from "#booking/model.ts";
import {
  corruptedDataFor,
  type ModelDataSource,
  modelDataFor,
  type TlaFact,
  tlaModule,
  tlaRecords,
} from "#scripts/verify-models/data.ts";
import {
  PARENT_CHILD_GROUP_UNITS,
  sharedGroupCapacity,
  sharedGroupRemaining,
} from "#shared/group-capacity.ts";
import { byGroup } from "#test-utils/by-group-map.ts";

/** One capacity fact for the checker. Every value is a production function
 *  output. A date-less surface has no per-date remaining, so `dateLess` is
 *  true and the dummy `remaining` is unused. A pair with no shared static cap
 *  has `hasStaticCap` false and a dummy `staticCap`. */
const groupFields = {
  allowed: "Bool",
  dateLess: "Bool",
  fits: "Int",
  hasStaticCap: "Bool",
  remaining: "Int",
  staticCap: "Int",
} as const;

type GroupFact = TlaFact<typeof groupFields>;

/** One parent/child pair with its group memberships and group maps. The
 *  memberships cover every branch the capacity functions take, so the model
 *  sees a real pool, a nearly-full pool, a date-less pool, and no pool at
 *  all. */
type Scenario = {
  readonly child: readonly number[];
  readonly name: string;
  readonly parent: readonly number[];
  readonly remainingBy: Readonly<Record<number, number>>;
  readonly staticBy: Readonly<Record<number, number>>;
};

/** One scenario row. The two listings use their own group ids, so no two
 *  rows share the same membership shape. */
const scenario = (
  name: string,
  parent: readonly number[],
  child: readonly number[],
  staticBy: Readonly<Record<number, number>>,
  remainingBy: Readonly<Record<number, number>>,
): Scenario => ({ child, name, parent, remainingBy, staticBy });

const SCENARIOS: readonly Scenario[] = [
  scenario("shares no group at all", [1], [2], { 1: 10, 2: 10 }, { 1: 3 }),
  scenario("shares a group with no cap", [7], [7], {}, {}),
  scenario("shares one capped group", [11], [11], { 11: 10 }, { 11: 5 }),
  scenario(
    "takes the tightest of several shared groups",
    [12, 13],
    [12, 13],
    { 12: 10, 13: 4 },
    { 12: 5, 13: 2 },
  ),
  scenario(
    "ignores the parent's own group the child never joins",
    [14, 15],
    [15],
    { 14: 0, 15: 10 },
    { 14: 0, 15: 5 },
  ),
  scenario(
    "ignores the child's tighter group the parent never joins",
    [16],
    [16, 17],
    { 16: 10, 17: 1 },
    { 16: 5, 17: 1 },
  ),
  scenario(
    "reads static cap and remaining from different shared groups",
    [18, 19],
    [18, 19],
    { 18: 10, 19: 4 },
    { 18: 5 },
  ),
  scenario(
    "date-less pool with a static cap below two",
    [23],
    [23],
    { 23: 1 },
    {},
  ),
  scenario("pool below two spots", [24], [24], { 24: 10 }, { 24: 1 }),
  scenario("pool of exactly two spots", [25], [25], { 25: 10 }, { 25: 2 }),
  scenario("odd pool", [26], [26], { 26: 10 }, { 26: 3 }),
  scenario("empty pool", [27], [27], { 27: 10 }, { 27: 0 }),
  scenario(
    "uncapped static group with tracked remaining",
    [28],
    [28],
    {},
    { 28: 5 },
  ),
  scenario(
    "static cap below two with spots still free",
    [29],
    [29],
    { 29: 1 },
    { 29: 5 },
  ),
  scenario(
    "uncapped static group with one spot left",
    [30],
    [30],
    {},
    { 30: 1 },
  ),
  scenario(
    "static cap and remaining both below two",
    [31],
    [31],
    { 31: 1 },
    { 31: 1 },
  ),
  scenario(
    "date-less pool with a static cap of ten",
    [32],
    [32],
    { 32: 10 },
    {},
  ),
];

/** The production outputs for one scenario. `sharedGroupRemaining` supplies
 *  the remaining fact, `sharedGroupCapacity` supplies the static cap and the
 *  allow gate. The two functions read the same shared groups, so their
 *  remaining agrees; the generator test pins the facts. */
const factFor = (scenario: Scenario): GroupFact => {
  const capacity = sharedGroupCapacity(
    scenario.parent,
    scenario.child,
    byGroup(scenario.staticBy),
    byGroup(scenario.remainingBy),
  );
  const remaining = sharedGroupRemaining(
    scenario.parent,
    scenario.child,
    byGroup(scenario.remainingBy),
  );
  const staticCap = capacity.staticCap;
  return {
    allowed: parentAndChildFitGroup(capacity),
    dateLess: remaining === undefined,
    fits:
      remaining === undefined
        ? 0
        : ticketsThatFitInPool(remaining, PARENT_CHILD_GROUP_UNITS),
    hasStaticCap: staticCap !== undefined,
    remaining: remaining ?? 0,
    staticCap: staticCap ?? 0,
  };
};

const FACTS: readonly GroupFact[] = SCENARIOS.map(factFor);

const moduleFor = (facts: readonly GroupFact[]): string =>
  tlaModule("SharedGroupCapacityData", [
    `PARENT_CHILD_GROUP_UNITS == ${PARENT_CHILD_GROUP_UNITS}`,
    `MaxRemaining == ${Math.max(...facts.map((fact) => fact.remaining))}`,
    `MaxStaticCap == ${Math.max(...facts.map((fact) => fact.staticCap))}`,
    `MaxSold == ${Math.max(...facts.map((fact) => fact.fits))}`,
    tlaRecords("GroupFacts", groupFields, facts),
  ]);

/** The clean proof data. The check must pass. */
export const sharedGroupCapacityModelData: ModelDataSource = modelDataFor(() =>
  moduleFor(FACTS),
);

/** A negative control over the clean facts, with each fact changed by
 *  `corrupt`. The checker must reject the result. */
const corruptedFacts = corruptedDataFor(FACTS, moduleFor);

/** The negative control for an overfill: the fit function overreports the
 *  whole orders every real pool holds. The checker must reject it. */
export const overfillCapacityData: ModelDataSource = corruptedFacts((fact) =>
  fact.dateLess ? fact : { ...fact, fits: fact.fits + 1 },
);

/** The negative control for a sold-out date-less pair: the allow gate passes
 *  a pair whose shared static cap is below two spots. The checker must
 *  reject it. */
export const dateLessSoldOutPairData: ModelDataSource = corruptedFacts(
  (fact) =>
    fact.dateLess &&
    fact.hasStaticCap &&
    fact.staticCap < PARENT_CHILD_GROUP_UNITS
      ? { ...fact, allowed: true }
      : fact,
);

import {
  parentAndChildFitGroup,
  ticketsThatFitInPool,
} from "#booking/model.ts";
import {
  type ModelDataSource,
  modelDataFor,
  tlaModule,
} from "#scripts/verify-models/data.ts";
import {
  PARENT_CHILD_GROUP_UNITS,
  sharedGroupCapacity,
  sharedGroupRemaining,
} from "#shared/group-capacity.ts";
import { byGroup } from "#test-utils/by-group-map.ts";

/** One generated group scenario. Every value is a production function
 *  output. A date-less surface has no per-date remaining, so `dateLess` is
 *  true and the dummy `remaining` is unused. A pair with no shared static cap
 *  has `hasStaticCap` false and a dummy `staticCap`. */
type GroupFact = {
  readonly allowed: boolean;
  readonly dateLess: boolean;
  readonly fits: number;
  readonly hasStaticCap: boolean;
  readonly remaining: number;
  readonly staticCap: number;
};

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
];

/** The production outputs for one scenario. `sharedGroupRemaining` and the
 *  capacity's remaining read the same shared groups, so they must agree;
 *  a drift is a generator bug the model would trust. */
const factFor = (scenario: Scenario): GroupFact => {
  const capacity = sharedGroupCapacity(
    scenario.parent,
    scenario.child,
    byGroup(scenario.staticBy),
    byGroup(scenario.remainingBy),
  );
  const shared = sharedGroupRemaining(
    scenario.parent,
    scenario.child,
    byGroup(scenario.remainingBy),
  );
  if (shared !== capacity.remaining) {
    throw new Error(
      `The shared remaining and the capacity remaining disagree for ${scenario.name}.`,
    );
  }
  const remaining = capacity.remaining;
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

const recordFor = (fact: GroupFact): string =>
  `[allowed |-> ${fact.allowed ? "TRUE" : "FALSE"}, dateLess |-> ${
    fact.dateLess ? "TRUE" : "FALSE"
  }, fits |-> ${fact.fits}, hasStaticCap |-> ${
    fact.hasStaticCap ? "TRUE" : "FALSE"
  }, remaining |-> ${fact.remaining}, staticCap |-> ${fact.staticCap}]`;

const moduleFor = (facts: readonly GroupFact[]): string =>
  tlaModule("SharedGroupCapacityData", [
    `PARENT_CHILD_GROUP_UNITS == ${PARENT_CHILD_GROUP_UNITS}`,
    `MaxRemaining == ${Math.max(...facts.map((fact) => fact.remaining))}`,
    `MaxStaticCap == ${Math.max(...facts.map((fact) => fact.staticCap))}`,
    `MaxSold == ${Math.max(...facts.map((fact) => fact.fits))}`,
    "\\* @typeAlias: groupFact = { allowed: Bool, dateLess: Bool, fits: Int, hasStaticCap: Bool, remaining: Int, staticCap: Int };",
    "\\* @type: Set($groupFact);",
    `GroupFacts == {\n${facts.map(recordFor).join(",\n")}\n}`,
  ]);

/** The clean proof data. The check must pass. */
export const sharedGroupCapacityModelData: ModelDataSource = modelDataFor(() =>
  moduleFor(FACTS),
);

/** The negative control for an overfill: the fit function overreports the
 *  whole orders every real pool holds. The checker must reject it. */
export const overfillCapacityData: ModelDataSource = modelDataFor(() =>
  moduleFor(
    FACTS.map((fact) =>
      fact.dateLess ? fact : { ...fact, fits: fact.fits + 1 },
    ),
  ),
);

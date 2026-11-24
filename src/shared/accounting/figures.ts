/** The money figures that the ledger reports read, each defined once over a
 * set of accounts. A per-listing report and a whole-ledger report read the
 * same definition, so the two cannot disagree. */

import { REVENUE, WRITEOFF_TYPE } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import {
  MANUAL_LISTING_COST,
  MANUAL_LISTING_INCOME,
} from "#accounting/manual-entries.ts";
import {
  type AccountId,
  type Accounts,
  amountOf,
  balanceIn,
  every,
  type LegTest,
  type Measure,
  measureOf,
  net,
  oneAccount,
  type Role,
  some,
} from "#accounting/projection-sql.ts";
import {
  amongConstants,
  type Counted,
  type Expr,
  equal,
  literal,
} from "#db/select/expression.ts";

/** Rows of these kinds with one of the accounts on `role`. `writeoff` names
 * the side of the row that holds the write-off account. */
type Flow = {
  readonly kinds: readonly string[];
  readonly role: Role;
  readonly writeoff?: Role;
};

/** A figure: the rows that add, and the rows that subtract, if any. */
type FigureSpec = { readonly adds: Flow; readonly subtracts?: Flow };

/* jscpd:ignore-start -- static data, not code */
const FIGURES = {
  externalCosts: { adds: { kinds: [MANUAL_LISTING_COST], role: "source" } },
  externalIncome: { adds: { kinds: [MANUAL_LISTING_INCOME], role: "dest" } },
  grossSales: {
    adds: { kinds: [KIND.sale, KIND.taxSale], role: "dest" },
    subtracts: { kinds: [KIND.taxSale], role: "source" },
  },
  manualAdjustments: {
    adds: { kinds: [KIND.adjustment], role: "dest", writeoff: "source" },
    subtracts: { kinds: [KIND.adjustment], role: "source", writeoff: "dest" },
  },
  refunds: {
    adds: { kinds: [KIND.refundSale, KIND.refundTaxSale], role: "source" },
    subtracts: { kinds: [KIND.refundTaxSale], role: "dest" },
  },
  servicingCosts: {
    adds: { kinds: [KIND.serviceCost], role: "source" },
    subtracts: { kinds: [KIND.serviceCost], role: "dest" },
  },
} as const satisfies Record<string, FigureSpec>;
/* jscpd:ignore-end */

/** The name of one figure of {@link FIGURES}. */
export type FigureName = keyof typeof FIGURES;

const onWriteoff =
  (role: Role): LegTest =>
  (leg) =>
    equal(leg[`${role}Type`], literal(WRITEOFF_TYPE));

const flowOf = (accounts: Accounts, flow: Flow): LegTest =>
  every(
    (leg) => amongConstants(leg.kind, flow.kinds),
    accounts(flow.role),
    ...(flow.writeoff === undefined ? [] : [onWriteoff(flow.writeoff)]),
  );

/** The figure `name` over `accounts`. */
export const figureOf = (
  name: FigureName,
  accounts: Accounts,
): Measure<Counted> => {
  const spec: FigureSpec = FIGURES[name];
  const adds = flowOf(accounts, spec.adds);
  return spec.subtracts === undefined
    ? amountOf(adds)
    : net(adds, flowOf(accounts, spec.subtracts));
};

/** What the accounts owe: their balance with the sides swapped. */
export const owedBy = (accounts: Accounts): Measure<Counted> =>
  balanceIn((role) => accounts(role === "dest" ? "source" : "dest"));

const INCOME_PARTS = [
  "externalIncome",
  "grossSales",
  "manualAdjustments",
] as const satisfies readonly FigureName[];

/** The three parts of recognised income over the revenue accounts. */
export const incomeParts = (revenue: Accounts) =>
  Object.fromEntries(
    INCOME_PARTS.map((name) => [name, figureOf(name, revenue)]),
  ) as Record<(typeof INCOME_PARTS)[number], Measure<Counted>>;

/** Recognised income over the revenue accounts: its three parts as one
 * figure. Write-offs count, and a refund leaves the earned amount alone. */
export const recognisedIncomeOf = (revenue: Accounts): Measure<Counted> => {
  const specs: FigureSpec[] = INCOME_PARTS.map((name) => FIGURES[name]);
  return net(
    some(...specs.map((spec) => flowOf(revenue, spec.adds))),
    some(
      ...specs.flatMap((spec) =>
        spec.subtracts === undefined ? [] : [flowOf(revenue, spec.subtracts)],
      ),
    ),
  );
};

/** The recognised income of one listing, as a value of another statement. */
export const listingIncomeSubquery = (id: AccountId): Expr<Counted> =>
  measureOf(recognisedIncomeOf(oneAccount(REVENUE, id)));

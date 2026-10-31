/** The checkout composition checker data: every pass fact and every order
 *  fact comes from the production pricing functions, so a slip in the
 *  composition rules makes the checker reject the derived facts. The
 *  largest-remainder split itself stays with LargestRemainderSplit.tla; the
 *  discount facts below consume its exactness. The negative controls live in
 *  composition-corruptions.ts. */

/* jscpd:ignore-start -- imports */
import { sum } from "#fp";
import {
  type ModelDataSource,
  type TlaFact,
  tlaModule,
  tlaRecords,
} from "#scripts/verify-models/data.ts";
import { feeSubtotalFor } from "#shared/booking-fee.ts";
import {
  allocateDiscount,
  type ModifierApplication,
  priceCheckout,
  ticketPaymentBreakdown,
} from "#shared/checkout-pricing.ts";
import type {
  CheckoutIntent,
  CheckoutItem,
  ModifierSpec,
} from "#shared/payments.ts";
import { modifierDelta } from "#shared/price-modifier.ts";
/* jscpd:ignore-end */

/** One order's final facts for the checker: the composition totals and the
 *  fee basis. `subtotal` is the generator's own composition result;
 *  `feeSubtotal` is the basis production recorded, so the checker sees a
 *  fee charged on any other subtotal. */
export const orderFields = {
  baseLineTotal: "Int",
  extraTotal: "Int",
  feeCount: "Int",
  feeSubtotal: "Int",
  lineTotal: "Int",
  numPasses: "Int",
  orderTag: "Str",
  remainingBalance: "Int",
  subtotal: "Int",
  total: "Int",
} as const;

/** One modifier pass's facts. `scopedSubtotal` is the base production
 *  recorded on the application; `origSubtotal` is the pre-modifier base the
 *  generator derives itself, so the checker sees any compounding.
 *  `currentSubtotal` is the in-scope price sum the discount clamps against.
 *  `added` is the extra charge an add pass contributes. */
export const passFields = {
  added: "Int",
  currentSubtotal: "Int",
  kind: "Str",
  orderTag: "Str",
  origSubtotal: "Int",
  passIndex: "Int",
  removed: "Int",
  requested: "Int",
  scopedSubtotal: "Int",
} as const;

/** One ticket unit a discount pass reduces: its price before and after. */
export const unitFields = {
  orderTag: "Str",
  passIndex: "Int",
  price: "Int",
  reduced: "Int",
  unitIndex: "Int",
} as const;

export type OrderFact = TlaFact<typeof orderFields>;
export type PassFact = TlaFact<typeof passFields>;
export type UnitFact = TlaFact<typeof unitFields>;

export type CompositionFacts = {
  readonly orderFacts: readonly OrderFact[];
  readonly passFacts: readonly PassFact[];
  readonly unitFacts: readonly UnitFact[];
};

/** One representative order the composition covers. */
type Scenario = {
  readonly items: readonly CheckoutItem[];
  readonly modifiers: readonly ModifierSpec[];
  readonly reservationAmount?: string;
  readonly sampleTag: string;
};

/** One bookable path in an order. */
const seat = (
  unitPrice: number,
  quantity: number,
  listingId = 1,
): CheckoutItem => ({
  listingId,
  name: "Seat",
  quantity,
  slug: "seat",
  unitPrice,
});

/** One modifier spec for an order. */
const pass = (
  kind: ModifierSpec["kind"],
  value: number,
  overrides: Partial<ModifierSpec> = {},
): ModifierSpec => ({
  id: 1,
  kind,
  listingIds: null,
  name: "Modifier",
  quantity: 1,
  trigger: "automatic",
  value,
  ...overrides,
});

/** The two-seat cart the whole-order scenarios share. */
const twoSeats = [seat(1000, 2)] as const;

/** The two-listing cart the scoped scenarios share. */
const twoListings = [seat(1000, 2), seat(1000, 1, 2)] as const;

/** The discounted two-seat order whose reservation variant keeps a balance. */
const discountedTickets: Scenario = {
  items: twoSeats,
  modifiers: [pass("fixed", -200)],
  sampleTag: "a discount reduces the tickets",
};

/** The representative orders: every pass kind and value shape, a scoped
 *  discount and a scoped add-on, a discount that outruns its units, and
 *  reservations with and without modifiers. The generator test pins the
 *  facts each order must produce. */
export const SCENARIOS: readonly Scenario[] = [
  {
    items: [seat(1000, 1)],
    modifiers: [],
    sampleTag: "a single ticket",
  },
  {
    items: twoSeats,
    modifiers: [pass("fixed", 500)],
    sampleTag: "an add-on raises the order",
  },
  discountedTickets,
  {
    items: twoSeats,
    modifiers: [pass("fixed", -200), pass("fixed", -100)],
    sampleTag: "modifiers never compound",
  },
  {
    items: [seat(500, 1)],
    modifiers: [pass("fixed", -1000)],
    sampleTag: "a discount that exceeds the units",
  },
  {
    items: twoListings,
    modifiers: [pass("fixed", -100, { listingIds: [1] })],
    sampleTag: "a scoped discount leaves other listings alone",
  },
  {
    items: twoSeats,
    modifiers: [],
    reservationAmount: "10%",
    sampleTag: "a reservation keeps a balance",
  },
  {
    items: [seat(1000, 1)],
    modifiers: [pass("percent", 0)],
    sampleTag: "a zero modifier changes nothing",
  },
  {
    items: twoSeats,
    modifiers: [pass("percent", -10)],
    sampleTag: "a percent discount scales with the subtotal",
  },
  {
    items: twoSeats,
    modifiers: [pass("multiply", 0.8)],
    sampleTag: "a multiplier reduces the tickets",
  },
  {
    items: twoSeats,
    modifiers: [pass("fixed", -200, { quantity: 2 })],
    sampleTag: "a modifier quantity scales the discount",
  },
  {
    ...discountedTickets,
    reservationAmount: "10%",
    sampleTag: "a reservation with a discount keeps a balance",
  },
  {
    items: twoListings,
    modifiers: [pass("fixed", 300, { listingIds: [1] })],
    sampleTag: "a scoped add-on raises one listing",
  },
];

/** One work unit while the passes run: its listing for scope, its original
 *  price, and its running charged price. */
type WorkUnit = {
  readonly listingId: number;
  readonly orig: number;
  price: number;
};

/** Explode an order's items into one work unit per ticket. */
const toUnits = (items: readonly CheckoutItem[]): WorkUnit[] =>
  items.flatMap((item) =>
    Array.from({ length: item.quantity }, () => ({
      listingId: item.listingId,
      orig: item.unitPrice,
      price: item.unitPrice,
    })),
  );

/** Whether a modifier scoped to `listingIds` covers a unit. */
const inScope = (spec: ModifierSpec, unit: WorkUnit): boolean =>
  spec.listingIds === null || spec.listingIds.includes(unit.listingId);

/** The pricing intent of one scenario. The contact fields are never read by
 *  the pricing functions; the type needs them. */
const intentFor = (
  scenario: Scenario,
  modifiers: readonly ModifierSpec[],
): CheckoutIntent => ({
  address: "",
  date: null,
  email: "buyer@example.com",
  items: [...scenario.items],
  modifiers: [...modifiers],
  name: "Buyer",
  phone: "",
  reservationAmount: scenario.reservationAmount,
  special_instructions: "",
});

/** One modifier pass applied to the work units: the pass fact, the units a
 *  reduce pass touches, the pass's extra charge, and the reduced units. */
const applyPass = (
  work: readonly WorkUnit[],
  spec: ModifierSpec,
  application: ModifierApplication,
  orderTag: string,
  passIndex: number,
): {
  addExtra: number;
  passFact: PassFact;
  units: readonly UnitFact[];
  work: readonly WorkUnit[];
} => {
  const scoped = work.filter((unit) => inScope(spec, unit));
  const baseSubtotal = sum(scoped.map((unit) => unit.orig));
  const delta = modifierDelta(baseSubtotal, spec.kind, spec.value);
  const kind = delta > 0 ? "add" : delta < 0 ? "reduce" : "zero";
  const requested = kind === "reduce" ? -delta * spec.quantity : 0;
  const currentSubtotal = sum(scoped.map((unit) => unit.price));
  if (kind === "reduce") {
    const reduced = allocateDiscount(
      scoped.map((unit) => unit.price),
      requested,
    );
    const removed = currentSubtotal - sum(reduced);
    const units: UnitFact[] = [];
    for (const [unitIndex, unit] of scoped.entries()) {
      units.push({
        orderTag,
        passIndex,
        price: unit.price,
        reduced: reduced[unitIndex]!,
        unitIndex: unitIndex + 1,
      });
    }
    let next = 0;
    return {
      addExtra: 0,
      passFact: {
        added: 0,
        currentSubtotal,
        kind,
        orderTag,
        origSubtotal: baseSubtotal,
        passIndex,
        removed,
        requested,
        scopedSubtotal: application.scopedSubtotal,
      },
      units,
      work: work.map((unit) =>
        inScope(spec, unit) ? { ...unit, price: reduced[next++]! } : unit,
      ),
    };
  }
  const addExtra = kind === "add" ? delta * spec.quantity : 0;
  return {
    addExtra,
    passFact: {
      added: addExtra,
      currentSubtotal,
      kind,
      orderTag,
      origSubtotal: baseSubtotal,
      passIndex,
      removed: 0,
      requested,
      scopedSubtotal: application.scopedSubtotal,
    },
    units: [],
    work,
  };
};

/** One scenario's derived facts: its passes, the units each reduce pass
 *  touches, and its final order totals. */
const factsFor = (scenario: Scenario): CompositionFacts => {
  const intent = intentFor(scenario, scenario.modifiers);
  const order = priceCheckout(intent);
  const passes: PassFact[] = [];
  const units: UnitFact[] = [];
  let work: readonly WorkUnit[] = toUnits(scenario.items);
  let addExtraTotal = 0;
  let removedTotal = 0;
  for (const [index, spec] of scenario.modifiers.entries()) {
    // Production records one application per spec, in spec order.
    const applied = applyPass(
      work,
      spec,
      order.modifierApplications[index]!,
      scenario.sampleTag,
      index + 1,
    );
    passes.push(applied.passFact);
    units.push(...applied.units);
    work = applied.work;
    addExtraTotal += applied.addExtra;
    removedTotal += applied.passFact.removed;
  }
  const fees = order.extras.filter((extra) => extra.key === "fee");
  const subtotal = feeSubtotalFor(intent) + addExtraTotal - removedTotal;
  // The fee basis production itself recorded: the configured fee subtotal
  // plus the net change its own applications report.
  const feeBasis =
    feeSubtotalFor(intent) +
    sum(order.modifierApplications.map((application) => application.delta));
  return {
    orderFacts: [
      {
        baseLineTotal: sum(
          scenario.items.map((item) => item.unitPrice * item.quantity),
        ),
        extraTotal: sum(
          order.extras.map((extra) => extra.amount * extra.quantity),
        ),
        feeCount: fees.length,
        feeSubtotal: feeBasis,
        lineTotal: sum(
          order.lines.map((line) => line.chargedUnitAmount * line.quantity),
        ),
        numPasses: scenario.modifiers.length,
        orderTag: scenario.sampleTag,
        remainingBalance: ticketPaymentBreakdown(intent).remainingBalance,
        subtotal,
        total: order.total,
      },
    ],
    passFacts: passes,
    unitFacts: units,
  };
};

/** Every scenario's facts, in scenario order. */
export const compositionFacts = (): CompositionFacts => {
  const orderFacts: OrderFact[] = [];
  const passFacts: PassFact[] = [];
  const unitFacts: UnitFact[] = [];
  for (const scenario of SCENARIOS) {
    const facts = factsFor(scenario);
    orderFacts.push(...facts.orderFacts);
    passFacts.push(...facts.passFacts);
    unitFacts.push(...facts.unitFacts);
  }
  return { orderFacts, passFacts, unitFacts };
};

export const checkoutCompositionData = (
  orderFacts: readonly OrderFact[],
  passFacts: readonly PassFact[],
  unitFacts: readonly UnitFact[],
): string =>
  tlaModule("CheckoutCompositionData", [
    tlaRecords("Orders", orderFields, orderFacts),
    tlaRecords("Passes", passFields, passFacts),
    tlaRecords("Units", unitFields, unitFacts),
  ]);

/** The generated checker data for the clean proof. */
export const checkoutCompositionModelData: ModelDataSource = async () => {
  const { orderFacts, passFacts, unitFacts } = compositionFacts();
  return checkoutCompositionData(orderFacts, passFacts, unitFacts);
};

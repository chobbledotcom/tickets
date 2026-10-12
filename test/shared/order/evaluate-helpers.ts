/**
 * The shared fixtures of the order-evaluator suites: one option builder with
 * every field defaulted to the simplest bookable shape, one pool builder,
 * and the state-kind projection the assertions read.
 */

import { evaluateOrder } from "#shared/order/evaluate.ts";
import type { OrderOption, OrderPools } from "#shared/order/options.ts";

/** An order option with every field defaulted to the simplest bookable shape. */
export const option = (
  key: string,
  units: [number, number][],
  over: Partial<OrderOption> = {},
): OrderOption => ({
  alternatives: [
    {
      spanDaysByListingId: new Map(),
      unitsByListingId: new Map(units),
    },
  ],
  bookableAlone: true,
  key,
  name: key,
  needsDate: false,
  spanDaysByListingId: new Map(),
  unitsByListingId: new Map(units),
  ...over,
});

export const pools = (over: Partial<OrderPools> = {}): OrderPools => ({
  days: [],
  groupIdsByListingId: new Map(),
  remainingByGroupDay: new Map(),
  remainingByGroupId: new Map(),
  remainingByListingDay: new Map(),
  remainingByListingId: new Map(),
  ...over,
});

export const kindsOf = (states: Map<string, { kind: string }>) =>
  Object.fromEntries([...states].map(([key, state]) => [key, state.kind]));

export { evaluateOrder };

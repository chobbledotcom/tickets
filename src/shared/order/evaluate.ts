import type {
  OrderOption,
  OrderOptionState,
  OrderPools,
} from "#shared/order/options.ts";
import { clampDurationDays } from "#types";

/**
 * Selections are honoured in the order they were added, so an earlier choice
 * always keeps its capacity. A new selection can grey out a later option but
 * never un-selects an earlier one.
 *
 * Overlap is NOT a conflict. Two packages sharing a listing simply sum their
 * demand, and both stay selectable while stock covers them. The aim is to never
 * restrict what can be booked beyond stock.
 *
 * When an option no longer fits, the message names the EARLIEST selected option
 * contending for the exhausted pool.
 */

/** Pool keys: each listing's own pool and each capped group's pool. */
const listingPool = (listingId: number): string => `L${listingId}`;
const groupPool = (groupId: number): string => `G${groupId}`;

/** The undated ledger day: a listing or group judged datelessly reads as one
 * undated day, so dated and dateless pools share one ledger shape. */
const UNDATED = "";

/** Every demand entry, as flat pool, day, and units triples. */
const demandEntries = function* (demand: Demand) {
  for (const [pool, byDay] of demand) {
    for (const [day, units] of byDay) yield { day, pool, units };
  }
};

/** The pool's remaining on one day, or undefined when untracked. */
const remainingOn = (ledger: Ledger, pool: string, day: string) =>
  ledger.get(pool)?.get(day);

/** The pool's day map, created on first use. */
const dayMapOf = (
  source: Demand | Ledger,
  pool: string,
): Map<string, number> => {
  const byDay = source.get(pool) ?? new Map<string, number>();
  source.set(pool, byDay);
  return byDay;
};

/** What one booking takes from each pool: its per-listing units over the
 * days that listing's booking occupies. The same demand joins each capped
 * group the listing shares. The days come from the booking's declared
 * spans, or one undated day when no date is chosen. Pool → day → units. */
type Demand = Map<string, Map<string, number>>;

/** The days one booking's demand occupies for one listing, from the spans
 * the booking declares. */
const demandDaysOf = (
  spans: ReadonlyMap<number, number>,
  pools: OrderPools,
  listingId: number,
): string[] => {
  if (pools.days.length === 0) return [UNDATED];
  if (!pools.remainingByListingDay.has(listingId)) return [UNDATED];
  const span = spans.get(listingId) ?? 1;
  return pools.days.slice(0, clampDurationDays(span));
};

/** What one booking takes from each pool: its per-listing units over the
 * days that listing's booking occupies (one undated day when no date is
 * chosen), plus the same demand on each capped group the listing shares.
 * Pool → day → units. */
const demandOfBooking = (
  unitsByListingId: ReadonlyMap<number, number>,
  spanDaysByListingId: ReadonlyMap<number, number>,
  pools: OrderPools,
): Demand => {
  const demand: Demand = new Map();
  const add = (pool: string, day: string, units: number) => {
    const byDay = dayMapOf(demand, pool);
    byDay.set(day, (byDay.get(day) ?? 0) + units);
  };
  for (const [listingId, units] of unitsByListingId) {
    for (const day of demandDaysOf(spanDaysByListingId, pools, listingId)) {
      add(listingPool(listingId), day, units);
      for (const groupId of pools.groupIdsByListingId.get(listingId) ?? []) {
        add(groupPool(groupId), day, units);
      }
    }
  }
  return demand;
};

/** What one selection of the option commits: its preview demand, the widest
 * alternative the judge answered. */
const demandOf = (option: OrderOption, pools: OrderPools): Demand =>
  demandOfBooking(option.unitsByListingId, option.spanDaysByListingId, pools);

/** The tracked pools and what is left in each, pool → day → remaining. Pools
 * without a limit are not tracked (unlimited). */
type Ledger = Map<string, Map<string, number>>;

const openLedger = (pools: OrderPools): Ledger => {
  const ledger: Ledger = new Map();
  const put = (pool: string, day: string, remaining: number) => {
    dayMapOf(ledger, pool).set(day, remaining);
  };
  for (const [listingId, remaining] of pools.remainingByListingId) {
    put(listingPool(listingId), UNDATED, remaining);
  }
  for (const [groupId, remaining] of pools.remainingByGroupId) {
    put(groupPool(groupId), UNDATED, remaining);
  }
  for (const [listingId, byDay] of pools.remainingByListingDay) {
    for (const [day, remaining] of byDay) {
      put(listingPool(listingId), day, remaining);
    }
  }
  for (const [groupId, byDay] of pools.remainingByGroupDay) {
    for (const [day, remaining] of byDay) {
      put(groupPool(groupId), day, remaining);
    }
  }
  return ledger;
};

/** A pool day the ledger cannot cover. */
type ShortPool = { day: string; pool: string };

/** The first demanded pool day the ledger cannot cover, or null when all
 * fit. The day rides along, so a blocker must hold the exact short day. */
const firstShortPool = (ledger: Ledger, demand: Demand): ShortPool | null => {
  const short = [...demandEntries(demand)].find(({ day, pool, units }) => {
    const remaining = remainingOn(ledger, pool, day);
    return remaining !== undefined && remaining < units;
  });
  return short === undefined ? null : { day: short.day, pool: short.pool };
};

/** Take the demand out of every tracked pool day (demand on untracked or
 * unlimited pools needs no bookkeeping). */
const commit = (ledger: Ledger, demand: Demand): void => {
  for (const { day, pool, units } of demandEntries(demand)) {
    const remaining = remainingOn(ledger, pool, day);
    if (remaining !== undefined) ledger.get(pool)!.set(day, remaining - units);
  }
};

/** Whether this option's availability can be judged right now. */
const judgeable = (option: OrderOption, dateChosen: boolean): boolean =>
  dateChosen || !option.needsDate;

/** Judge one unselected option against the cart: each rule that fails names
 * the option's state, and an option passing them all is plainly available.
 * The option is available when ANY alternative the judge answered fits
 * beside the cart — the buyer books one span, never their union. */
const judgeOption = (
  option: OrderOption,
  pools: OrderPools,
  ledger: Ledger,
  committed: readonly OrderOption[],
  dateChosen: boolean,
): OrderOptionState => {
  if (!option.bookableAlone) return { kind: "unavailable" };
  if (!judgeable(option, dateChosen)) return { kind: "needs_date" };
  const bookings = option.alternatives.map((alternative) =>
    demandOfBooking(
      alternative.unitsByListingId,
      alternative.spanDaysByListingId,
      pools,
    ),
  );
  if (bookings.some((booking) => firstShortPool(ledger, booking) === null)) {
    return { kind: "available" };
  }
  // No alternative fits beside the cart. Pick one that fits a fresh ledger —
  // it is bookable today, so the cart must be blocking it — and name the
  // committed selection that holds its exact short pool day. Only when NO
  // alternative fits a fresh ledger does the option never fit today at all.
  // Every judged option carries at least one alternative.
  const fresh = openLedger(pools);
  let chosen = 0;
  while (
    chosen < bookings.length &&
    firstShortPool(fresh, bookings[chosen]!) !== null
  ) {
    chosen++;
  }
  if (chosen === bookings.length) return { kind: "unavailable" };
  const short = firstShortPool(ledger, bookings[chosen]!)!;
  const blocker = committed.find((selected) => {
    const held = demandOf(selected, pools);
    return (held.get(short.pool)?.get(short.day) ?? 0) > 0;
  })!;
  return { byKey: blocker.key, byName: blocker.name, kind: "blocked" };
};

/**
 * Evaluate every option against the cart. `selectedKeys` is the visitor's
 * selection in the order it was added (unknown keys are ignored);
 * `dateChosen` says whether a date has been picked, letting date-needing
 * options be judged. Returns one {@link OrderOptionState} per option.
 */
export const evaluateOrder = (
  options: readonly OrderOption[],
  pools: OrderPools,
  selectedKeys: readonly string[],
  dateChosen: boolean,
): Map<string, OrderOptionState> => {
  const optionByKey = new Map(options.map((option) => [option.key, option]));
  const selections = selectedKeys.flatMap((key) => {
    const option = optionByKey.get(key);
    return option === undefined ? [] : [option];
  });
  const selectedSet = new Set(selections.map((option) => option.key));

  // Commit each selection's demand in cart order. A selection whose demand no
  // longer fits still counts as selected (the booking page is the authority);
  // its demand still commits, so later options are judged against the cart the
  // visitor actually intends to book.
  const ledger = openLedger(pools);
  const committed: OrderOption[] = [];
  for (const option of selections) {
    if (option.bookableAlone && judgeable(option, dateChosen)) {
      commit(ledger, demandOf(option, pools));
      committed.push(option);
    }
  }

  const states = new Map<string, OrderOptionState>();
  for (const option of options) {
    states.set(
      option.key,
      selectedSet.has(option.key)
        ? { kind: "selected" }
        : judgeOption(option, pools, ledger, committed, dateChosen),
    );
  }
  return states;
};

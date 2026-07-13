import type {
  OrderOption,
  OrderOptionState,
  OrderPools,
} from "#shared/order/options.ts";

/**
 * The pure order evaluator: subtract each of the visitor's selections from the
 * shared capacity pools in the order they were added, then judge every other
 * option against what remains.
 *
 * Selections are honoured in the order they were added — the earlier choice
 * always keeps its capacity, so adding something can grey out a later option
 * but never un-select an earlier one. Overlap is NOT a conflict: two packages
 * sharing a listing (or a package plus that listing's own card) simply sum
 * their demand, and both stay selectable while stock covers them — the aim is
 * to never restrict what can be booked beyond stock. When an option no longer
 * fits, the message names the earliest selected option contending for the
 * exhausted pool ("Remove <name> to add"); an option that would not fit even
 * on an empty cart is plainly unavailable.
 *
 * IO-free and context-agnostic: the caller resolves the options, pools, and
 * date; nothing here knows what surface it serves.
 */

/** Pool keys: each listing's own pool and each capped group's pool. */
const listingPool = (listingId: number): string => `L${listingId}`;
const groupPool = (groupId: number): string => `G${groupId}`;

/** What one selection of an option takes from each pool: its per-listing units
 * plus, per capped group, the summed units of its listings in that group. */
const demandOf = (
  option: OrderOption,
  pools: OrderPools,
): Map<string, number> => {
  const demand = new Map<string, number>();
  for (const [listingId, units] of option.unitsByListingId) {
    demand.set(listingPool(listingId), units);
    for (const groupId of pools.groupIdsByListingId.get(listingId) ?? []) {
      const key = groupPool(groupId);
      demand.set(key, (demand.get(key) ?? 0) + units);
    }
  }
  return demand;
};

/** The tracked pools and what is left in each. Pools without a limit are not
 * tracked (unlimited). */
type PoolLedger = Map<string, number>;

const openLedger = (pools: OrderPools): PoolLedger => {
  const ledger: PoolLedger = new Map();
  for (const [listingId, remaining] of pools.remainingByListingId) {
    ledger.set(listingPool(listingId), remaining);
  }
  for (const [groupId, remaining] of pools.remainingByGroupId) {
    ledger.set(groupPool(groupId), remaining);
  }
  return ledger;
};

/** The first demanded pool the ledger cannot cover, or null when all fit. */
const firstShortPool = (
  ledger: PoolLedger,
  demand: ReadonlyMap<string, number>,
): string | null => {
  for (const [pool, units] of demand) {
    const remaining = ledger.get(pool);
    if (remaining !== undefined && remaining < units) return pool;
  }
  return null;
};

/** Take the demand out of every tracked pool (demand on untracked/unlimited
 * pools needs no bookkeeping). */
const commit = (
  ledger: PoolLedger,
  demand: ReadonlyMap<string, number>,
): void => {
  for (const [pool, remaining] of ledger) {
    ledger.set(pool, remaining - (demand.get(pool) ?? 0));
  }
};

/** Whether this option's availability can be judged right now. */
const judgeable = (option: OrderOption, dateChosen: boolean): boolean =>
  dateChosen || !option.needsDate;

/** Judge one unselected option against the cart: each rule that fails names
 * the option's state, and an option passing them all is plainly available. */
const judgeOption = (
  option: OrderOption,
  pools: OrderPools,
  ledger: PoolLedger,
  committed: readonly OrderOption[],
  dateChosen: boolean,
): OrderOptionState => {
  if (!option.bookableAlone) return { kind: "unavailable" };
  if (!judgeable(option, dateChosen)) return { kind: "needs_date" };
  const demand = demandOf(option, pools);
  const shortPool = firstShortPool(ledger, demand);
  if (shortPool === null) return { kind: "available" };
  // Doesn't fit beside the cart. If it doesn't fit on a fresh ledger either,
  // it never fitted today at all; otherwise some committed selection is
  // holding the contested capacity — the pool only shrank through commits,
  // so the earliest committed selection drawing from it always exists.
  if (firstShortPool(openLedger(pools), demand) !== null) {
    return { kind: "unavailable" };
  }
  const blocker = committed.find((selected) =>
    demandOf(selected, pools).has(shortPool),
  )!;
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

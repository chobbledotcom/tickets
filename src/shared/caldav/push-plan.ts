/**
 * The pure heart of the CalDAV push task. Given the work waiting in the
 * database and how many calendar calls this wake may make, it decides exactly
 * what to do — and in what order — without touching the network or the clock.
 * The task shell reads the rows, calls `planPush`, and applies the result.
 *
 * Keeping this pure is what lets every rule below be proven by a fast unit
 * test with a fake clock, which is how the mutation gate stays cheap.
 */

/** A listing whose local copy has moved on but the calendar has not caught up. */
export type PendingListing = {
  readonly id: number;
  /** The revision the task read. Every clear is guarded by this exact value,
   * so an edit that lands after the read survives and re-pushes. */
  readonly pending: number;
  /** Has a real date (an empty date means "no event should exist"). */
  readonly dated: boolean;
  /** A create/update PUT has succeeded at least once (a remote copy exists). */
  readonly everPushed: boolean;
  /** When this listing was last tried, or null if it has never been tried. */
  readonly attemptAt: number | null;
};

/** A remote event we still owe a DELETE for. */
export type QueuedDelete = {
  readonly queueId: number;
  readonly listingId: number;
  /** The exact calendar address to DELETE. */
  readonly href: string;
  readonly attemptAt: number | null;
  /** The listing exists again and has a date, so this delete is stale. */
  readonly listingStillDated: boolean;
};

/** An already-mirrored listing eligible for a drift-correcting re-send. The
 * caller passes these oldest-pushed first, so the front of the list is the
 * calendar copy most likely to have gone stale. */
export type RefreshCandidate = { readonly id: number };

export type PushPlanInput = {
  /** How many calendar calls this wake may make. */
  readonly budget: number;
  readonly nowMs: number;
  /** Wait at least this long before retrying something that just failed. */
  readonly retryIntervalMs: number;
  readonly pending: readonly PendingListing[];
  readonly deletes: readonly QueuedDelete[];
  readonly refresh: readonly RefreshCandidate[];
};

/** Why a candidate was set aside this wake rather than acted on. */
export type SkipReason = "waiting-retry";

/**
 * One decided step. Local steps ("clearLocal", "queueDelete", "dropStaleDelete")
 * cost no calendar call; the rest each spend one call from the budget. "skip"
 * records a candidate we deliberately left for a later wake.
 */
export type PushAction =
  | { readonly kind: "clearLocal"; readonly ids: readonly number[] }
  | {
    readonly kind: "queueDelete";
    readonly listingId: number;
    readonly pending: number;
  }
  | { readonly kind: "dropStaleDelete"; readonly queueId: number }
  | {
    readonly kind: "deleteRemote";
    readonly queueId: number;
    readonly href: string;
  }
  | {
    readonly kind: "put";
    readonly listingId: number;
    readonly pending: number;
  }
  | { readonly kind: "refresh"; readonly listingId: number }
  | { readonly kind: "skip"; readonly reason: SkipReason };

export type PushPlan = {
  readonly actions: readonly PushAction[];
  /** True when due work was left unfinished, so the task should wake again
   * soon rather than waiting for the next scheduled pass. */
  readonly moreWork: boolean;
};

/** Items sorted into "ready now" and "still cooling off after a failure". */
type Readiness<T> = {
  /** Never tried — always ready, and preferred over retries. */
  readonly fresh: readonly T[];
  /** Tried before and now past their cool-off, oldest attempt first. */
  readonly dueRetry: readonly T[];
  /** Tried recently; still inside their cool-off, so left alone this wake. */
  readonly waiting: readonly T[];
};

const byAttemptAsc = (
  a: { attemptAt: number | null },
  b: {
    attemptAt: number | null;
  },
): number => (a.attemptAt ?? 0) - (b.attemptAt ?? 0);

const sortByReadiness = <T extends { attemptAt: number | null }>(
  items: readonly T[],
  nowMs: number,
  retryIntervalMs: number,
): Readiness<T> => {
  const fresh = items.filter((item) => item.attemptAt === null);
  const tried = items.filter((item) => item.attemptAt !== null);
  const isDue = (item: T) => nowMs - item.attemptAt! >= retryIntervalMs;
  return {
    dueRetry: tried.filter(isDue).sort(byAttemptAsc),
    fresh,
    waiting: tried.filter((item) => !isDue(item)),
  };
};

/**
 * Pick up to `slots` items to act on, keeping fresh work first while always
 * reserving a quarter of the slots for the oldest retries — so a steady stream
 * of new work can never starve a row that keeps failing.
 */
const chooseWithinBudget = <T>(
  fresh: readonly T[],
  dueRetry: readonly T[],
  slots: number,
): { readonly taken: readonly T[]; readonly deferred: number } => {
  if (slots <= 0) {
    return { deferred: fresh.length + dueRetry.length, taken: [] };
  }
  // Reserve a quarter of the slots for retries, but never more retries than
  // exist — an empty reserve would otherwise waste budget fresh work could use.
  const reserved = Math.min(Math.floor(slots / 4), dueRetry.length);
  const freshTaken = fresh.slice(0, slots - reserved);
  // Retries get their reserved slots plus any slots fresh work didn't fill.
  const retrySlots = reserved + (slots - reserved - freshTaken.length);
  const retryTaken = dueRetry.slice(0, retrySlots);
  return {
    deferred: fresh.length - freshTaken.length +
      (dueRetry.length - retryTaken.length),
    taken: [...freshTaken, ...retryTaken],
  };
};

/**
 * Divide the budget between deletes and pushes so neither can starve the
 * other. Whichever side has less work than its half hands the remainder to the
 * other, so a big backlog on one side still leaves the other side moving.
 */
const shareBudget = (
  budget: number,
  deleteDue: number,
  putDue: number,
): { readonly deleteSlots: number; readonly putSlots: number } => {
  if (deleteDue === 0) {
    return { deleteSlots: 0, putSlots: Math.min(budget, putDue) };
  }
  if (putDue === 0) {
    return { deleteSlots: Math.min(budget, deleteDue), putSlots: 0 };
  }
  const half = Math.floor(budget / 2);
  const deleteHalf = Math.min(deleteDue, half);
  const putSlots = Math.min(putDue, budget - deleteHalf);
  return { deleteSlots: Math.min(deleteDue, budget - putSlots), putSlots };
};

/** Split pending listings into the three shapes the commands table defines. */
const splitPending = (
  pending: readonly PendingListing[],
): {
  readonly clearIds: readonly number[];
  readonly queueDeletes: readonly PendingListing[];
  readonly puts: readonly PendingListing[];
} => ({
  // Dateless and never pushed: nothing remote exists, so clear locally, free.
  clearIds: pending
    .filter((row) => !row.dated && !row.everPushed)
    .map((row) => row.id),
  // Dated: a real create/update to send.
  puts: pending.filter((row) => row.dated),
  // Dateless but once pushed: owed a delete; queued now, drained next wake.
  queueDeletes: pending.filter((row) => !row.dated && row.everPushed),
});

/** Guaranteed slots for the drift-correcting refresh sweep, so a permanent
 * delete/push backlog can never freeze it out entirely. */
const refreshReserve = (budget: number, refreshCount: number): number =>
  refreshCount === 0 ? 0 : Math.min(refreshCount, Math.floor(budget / 8));

export const planPush = (input: PushPlanInput): PushPlan => {
  const { budget, deletes, nowMs, pending, refresh, retryIntervalMs } = input;
  const { clearIds, queueDeletes, puts } = splitPending(pending);

  const staleDeletes = deletes.filter((row) => row.listingStillDated);
  const liveDeletes = deletes.filter((row) => !row.listingStillDated);

  const deleteReady = sortByReadiness(liveDeletes, nowMs, retryIntervalMs);
  const putReady = sortByReadiness(puts, nowMs, retryIntervalMs);
  const deleteDue = deleteReady.fresh.length + deleteReady.dueRetry.length;
  const putDue = putReady.fresh.length + putReady.dueRetry.length;

  const reservedForRefresh = refreshReserve(budget, refresh.length);
  const workBudget = budget - reservedForRefresh;
  const { deleteSlots, putSlots } = shareBudget(workBudget, deleteDue, putDue);

  const chosenDeletes = chooseWithinBudget(
    deleteReady.fresh,
    deleteReady.dueRetry,
    deleteSlots,
  );
  const chosenPuts = chooseWithinBudget(
    putReady.fresh,
    putReady.dueRetry,
    putSlots,
  );

  const leftover = budget - chosenDeletes.taken.length -
    chosenPuts.taken.length;
  const chosenRefresh = refresh.slice(0, Math.max(0, leftover));

  const skips: PushAction[] = [...deleteReady.waiting, ...putReady.waiting].map(
    () => ({ kind: "skip", reason: "waiting-retry" }),
  );

  const actions: PushAction[] = [
    ...(clearIds.length > 0
      ? [{ ids: clearIds, kind: "clearLocal" } as const]
      : []),
    ...queueDeletes.map((row) => ({
      kind: "queueDelete" as const,
      listingId: row.id,
      pending: row.pending,
    })),
    ...staleDeletes.map((row) => ({
      kind: "dropStaleDelete" as const,
      queueId: row.queueId,
    })),
    ...chosenDeletes.taken.map((row) => ({
      href: row.href,
      kind: "deleteRemote" as const,
      queueId: row.queueId,
    })),
    ...chosenPuts.taken.map((row) => ({
      kind: "put" as const,
      listingId: row.id,
      pending: row.pending,
    })),
    ...chosenRefresh.map((row) => ({
      kind: "refresh" as const,
      listingId: row.id,
    })),
    ...skips,
  ];

  return {
    actions,
    // Deferred deletes/pushes that were due but didn't fit warrant a quick
    // re-wake. Refresh and cooling-off rows wait for the normal cadence.
    moreWork: chosenDeletes.deferred + chosenPuts.deferred > 0,
  };
};

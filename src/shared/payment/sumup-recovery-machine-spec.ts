/** The SumUp checkout-recovery machine as one executable table.
 *
 * SumUp does not sign its callbacks and has no subscription to redeliver
 * against, so a single lost callback is the whole of the notice we get. This
 * machine is what replaces that notice: every staged checkout is asked about
 * until SumUp gives a definitive answer, and a row that may be holding money
 * nobody has accounted for is never deleted and never left with nothing to
 * act on it.
 *
 * The table below IS the production lookup, not a description of one.
 * {@link recoveryMoveTo} reads it, the row writer reads each event's declared
 * writes and fence to build its `UPDATE`, pruning reads each node's
 * `prunable`, and the /admin/schema map derives from the same nodes. A cell
 * the table leaves out is a declared refusal, and the mirror sweep proves it
 * throws. */

import * as v from "valibot";
import {
  type MachineEvent,
  type MachineMoves,
  type MachineNode,
  movesIn,
  machineRep as rep,
} from "#shared/schema-atlas/machine-spec.ts";

/** The word stored in `sumup_checkouts.recovery_state`. It is also the node
 * id: where a row sits on the map and what it stores are one fact, so they
 * cannot drift apart. */
export const SumupRecoveryStateSchema = v.picklist([
  "finished",
  "owed",
  "staged",
  "unpaid",
  "waiting",
]);
export type SumupRecoveryState = v.InferOutput<typeof SumupRecoveryStateSchema>;
export const SUMUP_RECOVERY_STATES = SumupRecoveryStateSchema.options;
export const isSumupRecoveryState = (
  word: string,
): word is SumupRecoveryState => v.is(SumupRecoveryStateSchema, word);

export type RecoveryNodeId = SumupRecoveryState;

/** The two stored columns that decide which node a row sits on. */
export type SumupRecoveryRow = {
  readonly recoveryState: SumupRecoveryState;
  readonly sumupId: string;
};

/** Whether a node may be holding money nobody has accounted for. `waiting`
 * is unknown rather than no: until SumUp answers, a paid checkout whose
 * callback was lost looks exactly like one nobody ever paid — which is the
 * whole harm this machine exists to close. */
export type RecoveryOwesMoney = "no" | "unknown" | "yes";

export type RecoveryNode = MachineNode<SumupRecoveryRow, RecoveryNodeId> & {
  readonly owesMoney: RecoveryOwesMoney;
  /** Whether pruning may delete this row once it is old enough. */
  readonly prunable: boolean;
};

/** Stands for any real checkout id; the shapes only care whether one is
 * there. */
const A_CHECKOUT_ID = "sumup-checkout-id";

const rowIn = (state: SumupRecoveryState): SumupRecoveryRow => ({
  recoveryState: state,
  sumupId: state === "staged" ? "" : A_CHECKOUT_ID,
});

/** Every node, with the stored row behind it and the two facts the safety
 * property is stated over: a row that may hold money is never deleted, and
 * always has something that will act on it. */
export const RECOVERY_NODES: readonly RecoveryNode[] = [
  {
    id: "staged",
    owesMoney: "no",
    prunable: true,
    reps: [rep("no_checkout_id", rowIn("staged"))],
  },
  {
    id: "waiting",
    owesMoney: "unknown",
    prunable: false,
    reps: [rep("live_checkout", rowIn("waiting"))],
  },
  {
    id: "unpaid",
    owesMoney: "no",
    prunable: true,
    reps: [rep("never_paid", rowIn("unpaid"))],
  },
  {
    id: "finished",
    owesMoney: "no",
    prunable: true,
    reps: [rep("accounted_for", rowIn("finished"))],
  },
  {
    id: "owed",
    owesMoney: "yes",
    prunable: false,
    reps: [rep("unaccounted_for", rowIn("owed"))],
  },
];

export type RecoveryEventId =
  | "checkout_created"
  | "read_expired_or_failed"
  | "read_paid_booked"
  | "read_paid_contradiction"
  | "read_paid_settled"
  | "read_paid_unreadable"
  | "read_paid_unsettled"
  | "read_pending"
  | "read_unavailable";

/** What an event's `UPDATE` sets. There is deliberately no state-only
 * variant: an edge that moved a row without saying when to look at it again
 * would leave it due forever, so the type refuses to describe one. */
export type RecoveryWrites = "schedule" | "state_and_schedule";

/** What an event's `UPDATE` matches on, so the loser of a race finds no row
 * to write. Creation is keyed by the staged row itself; every later event
 * must still find the exact state and check time it read. */
export type RecoveryFence = "reference_index" | "state_and_schedule";

/** Whether an event is the row's creation or one of the checks that asks
 * SumUp what became of it. The queue of rows still worth asking about is
 * derived from this, so a new check event joins the queue by being declared. */
export type RecoveryEventKind = "check" | "create";

export type RecoveryMachineEvent = MachineEvent<
  SumupRecoveryRow,
  RecoveryEventId
> & {
  readonly fencesOn: RecoveryFence;
  readonly kind: RecoveryEventKind;
  readonly writes: RecoveryWrites;
};

/** The node one stored row sits on. Total: a state word and a checkout id
 * that disagree are a combination no writer can produce, so it is raised
 * rather than normalised — the live check is what finds those. */
export const recoveryNodeOf = (row: SumupRecoveryRow): RecoveryNodeId => {
  const hasCheckoutId = row.sumupId !== "";
  if (hasCheckoutId === (row.recoveryState === "staged")) {
    throw new Error(
      `A sumup_checkouts row cannot be ${row.recoveryState} with ` +
        `${hasCheckoutId ? "a" : "no"} checkout id`,
    );
  }
  return row.recoveryState;
};

/** Where one event moves a row, and the refusal when the table has no cell
 * for it. */
export const recoveryMoveTo = (
  from: RecoveryNodeId,
  event: RecoveryEventId,
): RecoveryNodeId => {
  const to = movesIn(RECOVERY_MOVES).expected(from, event, "");
  if (to === "refused") {
    throw new Error(`A ${from} SumUp checkout refuses ${event}`);
  }
  return to;
};

/** The row one event leaves behind, rebuilt from the columns its `UPDATE`
 * would set. Going back through {@link recoveryNodeOf} is the point: an
 * event that moved the state without giving the row a checkout id is caught
 * here rather than stored. */
export const recoveryRowAfter = (
  row: SumupRecoveryRow,
  event: RecoveryEventId,
  checkoutId: string,
): SumupRecoveryRow => {
  const moved: SumupRecoveryRow = {
    recoveryState: recoveryMoveTo(recoveryNodeOf(row), event),
    sumupId: event === "checkout_created" ? checkoutId : row.sumupId,
  };
  recoveryNodeOf(moved);
  return moved;
};

/** Runs one event the way the sweep needs it: the real move, over the real
 * row shape, landing on a row the real reader has to accept. */
const moves =
  (event: RecoveryEventId) =>
  (row: SumupRecoveryRow): SumupRecoveryRow =>
    recoveryRowAfter(row, event, A_CHECKOUT_ID);

const systemEvent = (
  id: RecoveryEventId,
  writes: RecoveryWrites,
  kind: RecoveryEventKind = "check",
  fencesOn: RecoveryFence = "state_and_schedule",
): RecoveryMachineEvent => ({
  actor: "system",
  fencesOn,
  id,
  kind,
  labelKey: `schema.sumup_recovery.edge.${id}`,
  movesMoney: id === "read_paid_settled" || id === "read_paid_unsettled",
  run: moves(id),
  writes,
});

/** Every way a staged checkout can move. The five `read_paid_*` events are
 * exhaustive over what the payment engine can answer for a paid checkout,
 * and each is named for the money fact it establishes, because that is what
 * decides whether the row may ever be deleted. */
export const RECOVERY_EVENTS: readonly RecoveryMachineEvent[] = [
  systemEvent(
    "checkout_created",
    "state_and_schedule",
    "create",
    "reference_index",
  ),
  systemEvent("read_unavailable", "schedule"),
  systemEvent("read_pending", "schedule"),
  systemEvent("read_expired_or_failed", "state_and_schedule"),
  systemEvent("read_paid_booked", "state_and_schedule"),
  systemEvent("read_paid_settled", "state_and_schedule"),
  systemEvent("read_paid_unsettled", "state_and_schedule"),
  systemEvent("read_paid_unreadable", "schedule"),
  systemEvent("read_paid_contradiction", "state_and_schedule"),
];

/** The declared machine. Every cell present is a required landing node;
 * every cell absent is a refusal the sweep executes.
 *
 * Read the refusals, because they are the contract too. `staged` takes no
 * read event — a row with no checkout id has nothing to ask SumUp about.
 * `unpaid` and `finished` take nothing at all: they are closed, and a late
 * event against one is a bug rather than a transition. `owed` refuses
 * `read_pending` and `read_expired_or_failed`, because every `owed` row got
 * there from a read that said PAID and a checkout never moves back off it. */
export const RECOVERY_MOVES: MachineMoves<RecoveryNodeId, RecoveryEventId> = {
  finished: {},
  owed: {
    read_paid_booked: "finished",
    read_paid_contradiction: "owed",
    read_paid_settled: "finished",
    read_paid_unreadable: "owed",
    read_paid_unsettled: "owed",
    read_unavailable: "owed",
  },
  staged: { checkout_created: "waiting" },
  unpaid: {},
  waiting: {
    read_expired_or_failed: "unpaid",
    read_paid_booked: "finished",
    read_paid_contradiction: "owed",
    read_paid_settled: "finished",
    read_paid_unreadable: "waiting",
    read_paid_unsettled: "owed",
    read_pending: "waiting",
    read_unavailable: "waiting",
  },
};

/** Whether the table has a cell for this pair at all. */
const accepts = (node: RecoveryNodeId, event: RecoveryEventId): boolean =>
  movesIn(RECOVERY_MOVES).expected(node, event, "") !== "refused";

/** The ids of every node a rule holds for — the one shape the derived lists
 * below share, so none of them can drift into reading the table differently. */
const nodeIdsWhere = (
  holds: (node: RecoveryNode) => boolean,
): readonly RecoveryNodeId[] =>
  RECOVERY_NODES.filter(holds).map((node) => node.id);

/** The nodes a row can never leave. Derived, so a cell added to a closed
 * row's line changes this rather than quietly contradicting it. */
export const RECOVERY_TERMINAL_NODES: readonly RecoveryNodeId[] = nodeIdsWhere(
  (node) => RECOVERY_EVENTS.every((event) => !accepts(node.id, event.id)),
);

/** One declared event by id. Throws on a name the machine does not have, so
 * a caller cannot quietly ask for a move that was never declared. */
export const recoveryEvent = (id: RecoveryEventId): RecoveryMachineEvent => {
  const event = RECOVERY_EVENTS.find((candidate) => candidate.id === id);
  if (event === undefined) {
    throw new Error(`The SumUp recovery machine has no ${id} event`);
  }
  return event;
};

/** The nodes still worth asking SumUp about: the ones some check can move.
 * Derived, so a node stops being asked about the moment its last check is
 * taken away, and a new one joins by being declared. */
export const RECOVERY_CHECKABLE_NODES: readonly RecoveryNodeId[] = nodeIdsWhere(
  (node) =>
    RECOVERY_EVENTS.some(
      (event) => event.kind === "check" && accepts(node.id, event.id),
    ),
);

/** The nodes pruning may delete on age alone. Everything else is kept until
 * it has a definitive answer, however old it gets. */
export const RECOVERY_PRUNABLE_NODES: readonly RecoveryNodeId[] = nodeIdsWhere(
  (node) => node.prunable,
);

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
 * {@link recoveryMoveTo} reads it, the queue's write takes its landing state
 * from it, pruning reads each node's `prunable`, and the /admin/schema map
 * derives from the same nodes. A cell the table leaves out is a declared
 * refusal, and the mirror sweep proves it throws. */

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
/** The one state before SumUp gives the row its provider checkout id. */
export const RECOVERY_STATE_WITHOUT_CHECKOUT_ID: SumupRecoveryState = "staged";
/** Read a stored word back as a state, refusing one this machine does not
 * have. A row carrying an unknown word is a database this code cannot reason
 * about, so it is raised where it is read rather than carried inward. */
export const parseSumupRecoveryState = (word: string): SumupRecoveryState => {
  if (!v.is(SumupRecoveryStateSchema, word)) {
    throw new Error(`A sumup_checkouts row holds unknown state ${word}`);
  }
  return word;
};

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
  sumupId: state === RECOVERY_STATE_WITHOUT_CHECKOUT_ID ? "" : A_CHECKOUT_ID,
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

/** Whether an event is the row's creation or one of the checks that asks
 * SumUp what became of it. The queue of rows still worth asking about is
 * derived from this, so a new check event joins the queue by being declared. */
export type RecoveryEventKind = "check" | "create";

export type RecoveryMachineEvent = MachineEvent<
  SumupRecoveryRow,
  RecoveryEventId
> & {
  readonly kind: RecoveryEventKind;
};

/** The node one stored row sits on. Total: a state word and a checkout id
 * that disagree are a combination no writer can produce, so it is raised
 * rather than normalised — the live check is what finds those. */
export const recoveryNodeOf = (row: SumupRecoveryRow): RecoveryNodeId => {
  const hasCheckoutId = row.sumupId !== "";
  if (
    hasCheckoutId ===
    (row.recoveryState === RECOVERY_STATE_WITHOUT_CHECKOUT_ID)
  ) {
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
  kind: RecoveryEventKind = "check",
): RecoveryMachineEvent => ({
  actor: "system",
  id,
  kind,
  labelKey: `schema.sumup_recovery.edge.${id}`,
  movesMoney: id === "read_paid_settled" || id === "read_paid_unsettled",
  run: moves(id),
});

/** Every way a staged checkout can move. The five `read_paid_*` events are
 * exhaustive over what the payment engine can answer for a paid checkout,
 * and each is named for the money fact it establishes, because that is what
 * decides whether the row may ever be deleted. */
export const RECOVERY_EVENTS: readonly RecoveryMachineEvent[] = [
  systemEvent("checkout_created", "create"),
  systemEvent("read_unavailable"),
  systemEvent("read_pending"),
  systemEvent("read_expired_or_failed"),
  systemEvent("read_paid_booked"),
  systemEvent("read_paid_settled"),
  systemEvent("read_paid_unsettled"),
  systemEvent("read_paid_unreadable"),
  systemEvent("read_paid_contradiction"),
];

/** The declared machine. Every cell present is a required landing node;
 * every cell absent is a refusal the sweep executes.
 *
 * Read the refusals, because they are the contract too. `staged` takes no
 * read event — a row with no checkout id has nothing to ask SumUp about.
 * `unpaid` and `finished` take nothing at all: they are closed. No callback
 * raises an event, so a late one reaches the payment engine and never this
 * table. `owed` refuses `read_pending` and `read_expired_or_failed`, because
 * every `owed` row got there from a read that said PAID and a checkout never
 * moves back off it. */
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

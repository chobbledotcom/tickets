/** SumUp does not sign its callbacks and has no subscription to redeliver
 * against, so a single lost callback is the whole of the notice we get. This
 * machine replaces that notice. Every staged checkout is asked about until
 * SumUp answers definitively. A row that can still hold unaccounted money is
 * never deleted, and always stays in a state something can act on.
 *
 * The table below IS the production lookup, not a description of one. A cell it
 * leaves out is a declared refusal, and the mirror sweep proves it throws. */

import * as v from "valibot";
import {
  derivedNodeIds,
  type MachineEvent,
  type MachineMoves,
  type MachineNode,
  movesIn,
  nodeIdsWhere,
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

/** Whether the two stored columns agree: every state except the one before
 * SumUp answers carries a checkout id. This is the one statement of that
 * rule — the node reader refuses a row that breaks it, and the live check
 * uses it to name the broken rule for the operator. */
export const recoveryCheckoutIdAgrees = (row: SumupRecoveryRow): boolean =>
  (row.sumupId !== "") ===
  (row.recoveryState !== RECOVERY_STATE_WITHOUT_CHECKOUT_ID);

/** The node one stored row sits on. Total: a state word and a checkout id
 * that disagree are a combination no writer can produce, so it is raised
 * rather than normalised — the live check is what finds those. */
export const recoveryNodeOf = (row: SumupRecoveryRow): RecoveryNodeId => {
  if (!recoveryCheckoutIdAgrees(row)) {
    throw new Error(
      `A sumup_checkouts row cannot be ${row.recoveryState} with ` +
        `${row.sumupId !== "" ? "a" : "no"} checkout id`,
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
  const to = RECOVERY_MOVES_READER.expected(from, event, "");
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

const systemEvent = <Id extends RecoveryEventId>(
  id: Id,
  kind: RecoveryEventKind = "check",
): RecoveryMachineEvent & { readonly id: Id } => ({
  actor: "system",
  id,
  kind,
  labelKey: `schema.sumup_recovery.edge.${id}`,
  movesMoney: id === "read_paid_settled" || id === "read_paid_unsettled",
  run: moves(id),
});

/** One entry per event id, each value bound to its own key, so an id added
 * to the union alone refuses to compile until its event is declared here —
 * and a key holding another id's event refuses too. The sweep and the queue
 * both derive from this record, so a declared event is a swept event. */
const RECOVERY_EVENT_OF: {
  readonly [Id in RecoveryEventId]: RecoveryMachineEvent & { readonly id: Id };
} = {
  checkout_created: systemEvent("checkout_created", "create"),
  read_expired_or_failed: systemEvent("read_expired_or_failed"),
  read_paid_booked: systemEvent("read_paid_booked"),
  read_paid_contradiction: systemEvent("read_paid_contradiction"),
  read_paid_settled: systemEvent("read_paid_settled"),
  read_paid_unreadable: systemEvent("read_paid_unreadable"),
  read_paid_unsettled: systemEvent("read_paid_unsettled"),
  read_pending: systemEvent("read_pending"),
  read_unavailable: systemEvent("read_unavailable"),
};

/** Every way a staged checkout can move. The five `read_paid_*` events are
 * exhaustive over what the payment engine can answer for a paid checkout,
 * and each is named for the money fact it establishes, because that is what
 * decides whether the row may ever be deleted. */
export const RECOVERY_EVENTS: readonly RecoveryMachineEvent[] =
  Object.values(RECOVERY_EVENT_OF);

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

/** The one reader over the declared table, built once. */
const RECOVERY_MOVES_READER = movesIn(RECOVERY_MOVES);

const RECOVERY_DERIVED = derivedNodeIds({
  events: RECOVERY_EVENTS,
  moves: RECOVERY_MOVES,
  nodes: RECOVERY_NODES,
});

/** The nodes still worth asking SumUp about: the ones some check can move.
 * Derived, so a node stops being asked about the moment its last check is
 * taken away, and a new one joins by being declared. A row carries a next
 * check time exactly when its state is on this list — the queue reads the
 * time, the writers set it, and the live check reports a row that breaks
 * the rule. */
export const RECOVERY_CHECKABLE_NODES: readonly RecoveryNodeId[] =
  RECOVERY_DERIVED.movedBy((event) => event.kind === "check");

/** The nodes pruning may delete on age alone. Everything else is kept until
 * it has a definitive answer, however old it gets. */
export const RECOVERY_PRUNABLE_NODES: readonly RecoveryNodeId[] = nodeIdsWhere(
  RECOVERY_NODES,
  (node) => node.prunable,
);

/** When the operator hears about a state's rows, keyed by the money answer
 * itself: money known to be unaccounted for is always listed, money nobody
 * has answered for is listed once the row is old, and money answered "no"
 * never is. A new money answer refuses to compile until someone decides
 * when the operator hears about its rows. */
const OPERATOR_LISTING_OF: {
  readonly [Owes in RecoveryOwesMoney]: "always" | "never" | "when_old";
} = {
  no: "never",
  unknown: "when_old",
  yes: "always",
};

const nodesHeardOf = (
  listing: "always" | "when_old",
): readonly RecoveryNodeId[] =>
  nodeIdsWhere(
    RECOVERY_NODES,
    (node) => OPERATOR_LISTING_OF[node.owesMoney] === listing,
  );

/** The nodes whose rows the operator always sees as unanswered money. */
export const RECOVERY_UNANSWERED_NODES: readonly RecoveryNodeId[] =
  nodesHeardOf("always");

/** The nodes whose rows the operator sees once they are old. A young row
 * here is normal — the task simply has not settled it yet — but an old one
 * means the task cannot get an answer, or cannot run at all. */
export const RECOVERY_UNANSWERED_WHEN_OLD_NODES: readonly RecoveryNodeId[] =
  nodesHeardOf("when_old");

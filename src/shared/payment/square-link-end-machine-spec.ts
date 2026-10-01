/** The machine that ends an unpaid Square checkout's payment link.
 *
 * A Square payment link stays payable for 180 days unless somebody ends it, so
 * the site stores one cancel handle per unpaid checkout and a task ends each
 * link at its window. The row is the whole machine: it exists exactly while
 * its link can still take payment, and leaves the table the moment Square
 * proves the link ended, was already gone, or was paid.
 *
 * `pending` and `ending` are the stored words. `unwritten` and `gone` are the
 * virtual ends of the map: a row that does not exist yet, and a row that no
 * longer exists. No writer ever stores either word — the database layer turns
 * a move to `gone` into a `DELETE`, and creation is an `INSERT` to `pending` —
 * so a stored word this machine does not have is raised where it is read. */

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import {
  derivedNodeIds,
  type MachineEvent,
  type MachineMoves,
  type MachineNode,
  moveOrRefuse,
  movesIn,
  nodeIdsWhere,
  parseMachineState,
  machineRep as rep,
} from "#shared/schema-atlas/machine-spec.ts";
/* jscpd:ignore-end */

/** The words a `square_link_ends.state` column can hold. */
export const SquareLinkEndStateSchema = v.picklist(["ending", "pending"]);
export type SquareLinkEndState = v.InferOutput<typeof SquareLinkEndStateSchema>;

/** Read a stored word back as a state, refusing one this machine does not
 * have. A row carrying an unknown word is a database this code cannot reason
 * about, so it is raised where it is read rather than carried inward. */
export const parseSquareLinkEndState = (word: string): SquareLinkEndState =>
  parseMachineState(SquareLinkEndStateSchema, word, "square_link_ends");

/** Every node on the map, stored and virtual alike. */
export type SquareLinkEndNodeId = SquareLinkEndState | "gone" | "unwritten";

/** The stored columns that decide which node a row sits on. */
export type SquareLinkEndRow = {
  readonly state: SquareLinkEndNodeId;
};

/** Whether the link behind a node can still take payment. The safety
 * property is stated over this fact: a row whose link can still take payment
 * is never pruned by retention, however old it gets. */
export type LinkTakesPayment = "no" | "until_square_answers" | "yes";

export type SquareLinkEndNode = MachineNode<
  SquareLinkEndRow,
  SquareLinkEndNodeId
> & {
  readonly takesPayment: LinkTakesPayment;
};

/** Every node, with the stored row behind it. */
export const LINK_END_NODES: readonly SquareLinkEndNode[] = [
  {
    id: "unwritten",
    reps: [rep("no_row_yet", { state: "unwritten" })],
    takesPayment: "no",
  },
  {
    id: "pending",
    reps: [rep("unclaimed", { state: "pending" })],
    takesPayment: "yes",
  },
  {
    // A worker holds the lease and has asked Square to end the link; until
    // Square answers, the page behind it can still be paid.
    id: "ending",
    reps: [rep("lease_held", { state: "ending" })],
    takesPayment: "until_square_answers",
  },
  {
    id: "gone",
    reps: [rep("row_deleted", { state: "gone" })],
    takesPayment: "no",
  },
];

export type SquareLinkEndEventId =
  | "checkout_created"
  | "claim_due"
  | "delete_answered_cancelled"
  | "delete_answered_missing"
  | "delete_inconclusive"
  | "delete_refused_paid"
  | "lease_expired"
  | "payment_completed";

/** Who fires an event: the checkout flow, the expiry task, or the payment
 * flow. The queue of rows the task asks about is derived from this, so an
 * event the task fires joins the queue by being declared. */
export type SquareLinkEndEventKind = "check" | "complete" | "create";

export type SquareLinkEndEvent = MachineEvent<
  SquareLinkEndRow,
  SquareLinkEndEventId
> & {
  readonly kind: SquareLinkEndEventKind;
};

/** Where one event moves a row, and the refusal when the table has no cell
 * for it. */
export const squareLinkEndMoveTo = (
  from: SquareLinkEndNodeId,
  event: SquareLinkEndEventId,
): SquareLinkEndNodeId =>
  moveOrRefuse(
    LINK_END_MOVES_READER,
    from,
    event,
    `A ${from} Square link end refuses ${event}`,
  );

/** Runs one event the way the sweep needs it: the real move, over the real
 * row shape, landing on a row the real reader has to accept. */
const moves =
  (event: SquareLinkEndEventId) =>
  (row: SquareLinkEndRow): SquareLinkEndRow => ({
    state: squareLinkEndMoveTo(row.state, event),
  });

const taskEvent = <Id extends SquareLinkEndEventId>(
  id: Id,
  kind: SquareLinkEndEventKind,
): SquareLinkEndEvent & { readonly id: Id } => ({
  actor:
    kind === "create" ? "system" : kind === "check" ? "system" : "provider",
  id,
  kind,
  labelKey: `schema.square_link_ends.edge.${id}`,
  movesMoney: false,
  run: moves(id),
});

/** One entry per event id, each value bound to its own key, so an id added to
 * the union alone refuses to compile until its event is declared here. */
const LINK_END_EVENT_OF: {
  readonly [Id in SquareLinkEndEventId]: SquareLinkEndEvent & {
    readonly id: Id;
  };
} = {
  checkout_created: taskEvent("checkout_created", "create"),
  claim_due: taskEvent("claim_due", "check"),
  delete_answered_cancelled: taskEvent("delete_answered_cancelled", "check"),
  delete_answered_missing: taskEvent("delete_answered_missing", "check"),
  delete_inconclusive: taskEvent("delete_inconclusive", "check"),
  delete_refused_paid: taskEvent("delete_refused_paid", "check"),
  lease_expired: taskEvent("lease_expired", "check"),
  payment_completed: taskEvent("payment_completed", "complete"),
};

export const LINK_END_EVENTS: readonly SquareLinkEndEvent[] =
  Object.values(LINK_END_EVENT_OF);

/** Every way a handle row can move. Read the refusals, because they are the
 * contract too. `pending` refuses every delete answer — the claim comes
 * first, so no two workers ever send Square the same delete. `ending` refuses
 * `payment_completed` — once the task holds the lease, the completion's
 * conditional delete finds no row and the task's own refusal names the paid
 * order. `gone` takes nothing at all: no row exists to move. */
export const LINK_END_MOVES: MachineMoves<
  SquareLinkEndNodeId,
  SquareLinkEndEventId
> = {
  ending: {
    delete_answered_cancelled: "gone",
    delete_answered_missing: "gone",
    delete_inconclusive: "pending",
    delete_refused_paid: "gone",
    lease_expired: "pending",
  },
  gone: {},
  pending: {
    claim_due: "ending",
    payment_completed: "gone",
  },
  unwritten: { checkout_created: "pending" },
};

/** The one reader over the declared table, built once. */
const LINK_END_MOVES_READER = movesIn(LINK_END_MOVES);

const LINK_END_DERIVED = derivedNodeIds({
  events: LINK_END_EVENTS,
  moves: LINK_END_MOVES,
  nodes: LINK_END_NODES,
});

/** The nodes the expiry task asks about: the ones one of its own events can
 * move. A row carries a next attempt time exactly while its state is on this
 * list. */
export const LINK_END_CHECKABLE_NODES: readonly SquareLinkEndNodeId[] =
  LINK_END_DERIVED.movedBy((event) => event.kind === "check");

/** The nodes whose link can still take payment. Retention never deletes these
 * rows on age alone. */
export const LINK_END_PAYABLE_NODES: readonly SquareLinkEndNodeId[] =
  nodeIdsWhere(LINK_END_NODES, (node) => node.takesPayment !== "no");

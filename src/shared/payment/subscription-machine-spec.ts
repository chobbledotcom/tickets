// effects: pure
/** The machine of the subscription on one booking row.
 *
 * Stripe owns the status word. The site groups each word onto one node: no
 * subscription, a live one, or an ended one. A Stripe read moves a live row by
 * the status it reports. The scheduled check and a webhook delivery each make
 * that read. An ended row takes nothing. */

import { isOneOf } from "#fp";
import {
  derivedNodeIds,
  type MachineMoves,
  type MachineNode,
  moveOrRefuse,
  movesIn,
  machineRep as rep,
} from "#shared/schema-atlas/machine-spec.ts";
import {
  SUBSCRIPTION_NODE_OF,
  type SubscriptionStatus,
  SubscriptionStatusSchema,
} from "#shared/subscriptions/plan.ts";

export type SubscriptionNodeId = "ended" | "live" | "none";

type StatusNodeId = Exclude<SubscriptionNodeId, "none">;

/** The stored column that decides the node: blank before any subscription. */
type SubscriptionRow = { readonly status: SubscriptionStatus | "" };

const statusesOn = (node: StatusNodeId): SubscriptionStatus[] =>
  SubscriptionStatusSchema.options.filter(
    (status) => SUBSCRIPTION_NODE_OF[status] === node,
  );

const statusNode = (
  id: StatusNodeId,
): MachineNode<SubscriptionRow, SubscriptionNodeId> => ({
  id,
  reps: statusesOn(id).map((status) => rep(status, { status })),
});

export const SUBSCRIPTION_NODES: readonly MachineNode<
  SubscriptionRow,
  SubscriptionNodeId
>[] = [
  { id: "none", reps: [rep("no_subscription", { status: "" })] },
  statusNode("live"),
  statusNode("ended"),
];

export type SubscriptionEventId =
  | "checkout_completed"
  | "observed_ended"
  | "observed_live"
  | "owner_cancelled";

/** Who fires an event: the paid checkout, a Stripe read, or the owner. */
type SubscriptionEvent = {
  readonly id: SubscriptionEventId;
  readonly kind: "cancel" | "complete" | "observe";
};

/* jscpd:ignore-start -- a list of strings, not code */
export const SUBSCRIPTION_EVENTS: readonly SubscriptionEvent[] = [
  { id: "checkout_completed", kind: "complete" },
  { id: "observed_live", kind: "observe" },
  { id: "observed_ended", kind: "observe" },
  { id: "owner_cancelled", kind: "cancel" },
];
/* jscpd:ignore-end */

/** Every way a row can move. An ended row refuses every event. */
export const SUBSCRIPTION_MOVES: MachineMoves<
  SubscriptionNodeId,
  SubscriptionEventId
> = {
  ended: {},
  live: {
    observed_ended: "ended",
    observed_live: "live",
    owner_cancelled: "ended",
  },
  none: { checkout_completed: "live" },
};

const MOVES_READER = movesIn(SUBSCRIPTION_MOVES);

/** The event a Stripe read fires for the status it reports. */
const EVENT_OF: Record<StatusNodeId, SubscriptionEventId> = {
  ended: "observed_ended",
  live: "observed_live",
};

/** Where a Stripe read moves a row that holds `from` when it reports
 * `observed`. A row that the read cannot move is refused loudly. */
export const observedStatusNode = (
  from: SubscriptionStatus,
  observed: SubscriptionStatus,
): SubscriptionNodeId =>
  moveOrRefuse(
    MOVES_READER,
    SUBSCRIPTION_NODE_OF[from],
    EVENT_OF[SUBSCRIPTION_NODE_OF[observed]],
    `A ${from} subscription refuses what Stripe reports`,
  );

const NODES_MOVED_BY = derivedNodeIds({
  events: SUBSCRIPTION_EVENTS,
  moves: SUBSCRIPTION_MOVES,
  nodes: SUBSCRIPTION_NODES,
}).movedBy;

/** The status words on the nodes that events of `kind` move. */
const statusesMovedBy = (
  kind: SubscriptionEvent["kind"],
): readonly SubscriptionStatus[] => {
  const nodes = NODES_MOVED_BY((event) => event.kind === kind);
  return SubscriptionStatusSchema.options.filter((status) =>
    nodes.includes(SUBSCRIPTION_NODE_OF[status]),
  );
};

/** The status words of a live row: the rows that a Stripe read acts on. */
export const LIVE_STATUSES = statusesMovedBy("observe");

/** The status words of the rows an owner can cancel. A booking row that holds
 * one of them cannot be deleted. */
export const CANCELLABLE_STATUSES = statusesMovedBy("cancel");

/** Whether a stored status word names a subscription that the owner can
 * still cancel. A blank word names none. */
export const isCancellable = isOneOf(CANCELLABLE_STATUSES);

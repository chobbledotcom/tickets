// effects: pure
/** The machine of the subscription on one booking row.
 *
 * Stripe owns the status word. The site groups each word onto one node: no
 * subscription, a live one, or an ended one. The scheduled check moves a
 * live row by the status Stripe reports. An ended row takes nothing. */

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
  | "check_saw_ended"
  | "check_saw_live"
  | "checkout_completed";

/** Who fires an event: the paid checkout, or the scheduled check. */
type SubscriptionEvent = {
  readonly id: SubscriptionEventId;
  readonly kind: "check" | "complete";
};

export const SUBSCRIPTION_EVENTS: readonly SubscriptionEvent[] = [
  { id: "checkout_completed", kind: "complete" },
  { id: "check_saw_live", kind: "check" },
  { id: "check_saw_ended", kind: "check" },
];

/** Every way a row can move. An ended row refuses every event. */
export const SUBSCRIPTION_MOVES: MachineMoves<
  SubscriptionNodeId,
  SubscriptionEventId
> = {
  ended: {},
  live: { check_saw_ended: "ended", check_saw_live: "live" },
  none: { checkout_completed: "live" },
};

const MOVES_READER = movesIn(SUBSCRIPTION_MOVES);

/** The event the scheduled check fires for the status Stripe reports. */
const CHECK_EVENT_OF: Record<StatusNodeId, SubscriptionEventId> = {
  ended: "check_saw_ended",
  live: "check_saw_live",
};

/** Where the check moves a row that holds `from` when Stripe reports
 * `observed`. A row the check cannot move is refused loudly. */
export const checkedStatusNode = (
  from: SubscriptionStatus,
  observed: SubscriptionStatus,
): SubscriptionNodeId =>
  moveOrRefuse(
    MOVES_READER,
    SUBSCRIPTION_NODE_OF[from],
    CHECK_EVENT_OF[SUBSCRIPTION_NODE_OF[observed]],
    `A ${from} subscription refuses the scheduled check`,
  );

const CHECKED_NODES = derivedNodeIds({
  events: SUBSCRIPTION_EVENTS,
  moves: SUBSCRIPTION_MOVES,
  nodes: SUBSCRIPTION_NODES,
}).movedBy((event) => event.kind === "check");

/** The status words of the rows the scheduled check asks Stripe about. */
export const CHECKED_STATUSES: readonly SubscriptionStatus[] =
  SubscriptionStatusSchema.options.filter((status) =>
    CHECKED_NODES.includes(SUBSCRIPTION_NODE_OF[status]),
  );

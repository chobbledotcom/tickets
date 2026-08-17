/** Whole-machine properties computed over the declared refund table, so a
 * false cell must survive a global constraint, not just a local opinion:
 * every node is reachable, every blocking node can end, the one
 * provider-wait is declared, an exit out of an attention state changes the
 * condition it entered on, and every lifecycle clearer really drives an
 * exit from the state it claims to clear. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundLifecycleFor } from "#shared/payment/refund-authority-lifecycle.ts";
import type { RefundAuthorityState } from "#shared/payment/refund-authority-state.ts";
import {
  REFUND_EVENTS,
  REFUND_MOVES,
  REFUND_NODES,
  type RefundEventId,
  type RefundMachineEvent,
  type RefundNode,
  type RefundNodeId,
  refundNodeOf,
} from "#shared/payment/refund-machine-spec.ts";
import { machineGraph } from "#test-utils/machine-graph.ts";

const graph = machineGraph({
  events: REFUND_EVENTS,
  label: "refund",
  nodes: REFUND_NODES,
  targets: (from: RefundNodeId, event: RefundEventId) =>
    REFUND_MOVES.targets(from, event),
});

/** The walk with the provider's own moves taken away. */
const withoutProvider = (event: RefundMachineEvent): boolean =>
  event.actor !== "provider";

/** Whether deleting the attendee row is blocked while a record sits here.
 * Guarded by a test below: all of a node's shapes must agree on this. */
const blocksDelete = (node: RefundNode): boolean =>
  refundLifecycleFor(node.reps[0]!.state).blocks.delete;

/** The nodes that hold a required decision or an unsettled check. */
const ATTENTION_NODES = [
  "check",
  "choice_not_sent",
  "choice_open",
  "choice_returned",
] as const;
type AttentionNodeId = (typeof ATTENTION_NODES)[number];
const attentionSet = new Set<RefundNodeId>(ATTENTION_NODES);
const isAttention = (node: RefundNodeId): node is AttentionNodeId =>
  attentionSet.has(node);

/** The events whose success is what parks a record on each attention node. */
const ENTERING_EVENTS: Readonly<
  Record<AttentionNodeId, readonly RefundEventId[]>
> = {
  check: ["conflict_wait"],
  choice_not_sent: ["conflict_not_sent"],
  choice_open: ["expired", "possibly_sent", "rejected", "unreadable"],
  choice_returned: ["conflict_returned"],
};

/** The exits one attention node declares: every (event, shape) cell whose
 * transition must succeed. */
const declaredExits = (
  node: RefundNode,
): readonly {
  readonly event: RefundMachineEvent;
  readonly source: RefundAuthorityState;
  readonly tag: string;
  readonly target: RefundNodeId;
}[] =>
  REFUND_EVENTS.flatMap((event) =>
    node.reps.flatMap(({ state, tag }) => {
      const target = REFUND_MOVES.expected(node.id, event.id, tag);
      return target === "refused"
        ? []
        : [{ event, source: state, tag, target }];
    }),
  );

/** One exit's proof that the condition changed, judged by where it landed:
 * settled money refuses re-entry, a re-opened send is a new generation, and
 * re-classified evidence moves the revision forward. */
const expectConditionChanged = (
  attentionId: AttentionNodeId,
  cell: string,
  source: RefundAuthorityState,
  result: RefundAuthorityState,
): void => {
  const landed = refundNodeOf(result);
  if (landed === "returned") {
    for (const enter of ENTERING_EVENTS[attentionId]) {
      expect(
        () => graph.eventById(enter).run(result),
        `${cell} then ${enter} must refuse`,
      ).toThrow();
    }
  } else if (landed === "ready") {
    expect(result.request.generation, cell).toBe(source.request.generation + 1);
    expect(result.evidenceRevision, cell).toBeGreaterThan(
      source.evidenceRevision,
    );
  } else {
    expect(isAttention(landed), cell).toBe(true);
    expect(result.evidenceRevision, cell).toBe(source.evidenceRevision + 1);
  }
};

describe("the refund machine graph", () => {
  test("every node is reachable from ready", () => {
    expect([...graph.reachableFrom("ready")].sort()).toEqual(
      REFUND_NODES.map(({ id }) => id).sort(),
    );
  });

  test("every shape of a node agrees on whether it blocks deleting", () => {
    for (const node of REFUND_NODES) {
      const answers = new Set(
        node.reps.map(({ state }) => refundLifecycleFor(state).blocks.delete),
      );
      expect(answers.size, node.id).toBe(1);
    }
  });

  test("every blocking node has a path to recorded", () => {
    // The needs_provider_check dead end shipped because no declared exit
    // could ever fire; this is the check that makes that impossible now.
    for (const node of REFUND_NODES.filter(blocksDelete)) {
      expect(
        graph.reachableFrom(node.id).has("recorded"),
        `${node.id} cannot end`,
      ).toBe(true);
    }
  });

  test("only the declared provider-wait cannot end without the provider", () => {
    const stuckWithoutProvider = REFUND_NODES.filter(
      ({ id }) => !graph.reachableFrom(id, withoutProvider).has("recorded"),
    ).map(({ id }) => id);
    const declaredWaits = REFUND_NODES.filter(
      ({ awaits }) => awaits === "provider",
    ).map(({ id }) => id);
    // The two lists must match exactly: a node that needs the provider to
    // finish must say so, and a node that says so must really need it.
    expect(stuckWithoutProvider).toEqual(declaredWaits);
    expect(declaredWaits).toEqual(["check"]);
  });

  test("the entering-events map matches the table in both directions", () => {
    // Set equality proves each listed event really parks records here AND
    // that no unlisted event does — an omission would silently drop that
    // event from the settled-money re-entry proof below.
    for (const attention of ATTENTION_NODES) {
      const landing = REFUND_EVENTS.filter((event) =>
        REFUND_NODES.some((node) =>
          node.reps.some(
            ({ tag }) =>
              REFUND_MOVES.expected(node.id, event.id, tag) === attention,
          ),
        ),
      ).map(({ id }) => id);
      expect([...landing].sort(), attention).toEqual(
        [...ENTERING_EVENTS[attention]].sort(),
      );
    }
  });

  test("an exit out of an attention state changes the condition it entered on", () => {
    let checkedExits = 0;
    for (const attentionId of ATTENTION_NODES) {
      for (const { event, source, tag } of declaredExits(
        graph.nodeById(attentionId),
      )) {
        checkedExits++;
        expectConditionChanged(
          attentionId,
          `${attentionId} × ${event.id} [${tag}]`,
          source,
          event.run(source),
        );
      }
    }
    // check's 4 events × 3 shapes, choice_open's 6 × 4, and one owner exit
    // for each of the 3 shapes behind the two settled decisions.
    expect(checkedExits).toBe(12 + 24 + 3 + 3);
  });

  test("every shape of a blocking node has its own way out", () => {
    // The union graph cannot see a strand that hits only one capability:
    // if every exit from a node were split away from one shape, that shape
    // would wait forever while the node as a whole looked alive.
    for (const node of REFUND_NODES.filter(blocksDelete)) {
      for (const { tag } of node.reps) {
        const exits = REFUND_EVENTS.filter((event) => {
          const target = REFUND_MOVES.expected(node.id, event.id, tag);
          return target !== "refused" && target !== node.id;
        });
        expect(exits.length, `${node.id} [${tag}] is stranded`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  test("every blocking node's declared clearer drives a declared exit", () => {
    // The clearer names the route that ends the state; each route fires a
    // known family of machine events.
    const CLEARER_EVENTS: Readonly<Record<string, readonly RefundEventId[]>> = {
      markRefundAuthorityRecorded: ["record_in_money"],
      requestProviderRefund: [
        "arm",
        "observe",
        "replay",
        "proved_not_sent",
        "provider_returned",
        "unreadable",
        "rejected",
        "expired",
        "possibly_sent",
        "conflict_returned",
        "conflict_not_sent",
        "conflict_wait",
      ],
      resolveProviderRefundCase: [
        "owner_confirms_returned",
        "owner_confirms_not_sent",
      ],
    };
    for (const node of REFUND_NODES.filter(blocksDelete)) {
      const clearer = refundLifecycleFor(node.reps[0]!.state).clearedBy;
      const events = CLEARER_EVENTS[clearer];
      if (events === undefined) {
        throw new Error(`${node.id} names unknown clearer ${clearer}`);
      }
      const drivesAnExit = events.some((eventId) =>
        node.reps.some(
          ({ tag }) =>
            REFUND_MOVES.expected(node.id, eventId, tag) !== "refused",
        ),
      );
      expect(drivesAnExit, `${clearer} cannot clear ${node.id}`).toBe(true);
    }
  });
});

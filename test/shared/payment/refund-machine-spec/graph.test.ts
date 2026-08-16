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
  EXPECTED_MOVES,
  REFUND_EVENTS,
  REFUND_MOVES,
  REFUND_NODES,
  type RefundEventId,
  type RefundMachineEvent,
  type RefundNode,
  type RefundNodeId,
  refundNodeOf,
} from "#shared/payment/refund-machine-spec.ts";
import {
  type ExpectedMove,
  expectedTargets,
} from "#shared/schema-atlas/machine-spec.ts";
import type { AtlasActor } from "#shared/schema-atlas/types.ts";

const ALL_ACTORS: readonly AtlasActor[] = ["owner", "provider", "system"];
const WITHOUT_PROVIDER: readonly AtlasActor[] = ["owner", "system"];

const eventById = (id: RefundEventId): RefundMachineEvent => {
  const event = REFUND_EVENTS.find((candidate) => candidate.id === id);
  if (event === undefined) throw new Error(`Unknown refund event ${id}`);
  return event;
};

const nodeById = (id: RefundNodeId): RefundNode => {
  const node = REFUND_NODES.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`Unknown refund node ${id}`);
  return node;
};

/** Every node one declared step away from `from`, for the given actors. */
const successors = (
  from: RefundNodeId,
  actors: readonly AtlasActor[],
): readonly RefundNodeId[] =>
  REFUND_EVENTS.filter((event) => actors.includes(event.actor)).flatMap(
    (event) => {
      const move: ExpectedMove<RefundNodeId> | undefined =
        EXPECTED_MOVES[from][event.id];
      return move === undefined ? [] : expectedTargets(move);
    },
  );

/** Every node the table lets a record reach from `start`, for the given
 * actors. */
const reachableFrom = (
  start: RefundNodeId,
  actors: readonly AtlasActor[],
): Set<RefundNodeId> => {
  const seen = new Set<RefundNodeId>([start]);
  const queue: RefundNodeId[] = [start];
  for (let index = 0; index < queue.length; index++) {
    for (const next of successors(queue[index]!, actors)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
};

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
        () => eventById(enter).run(result),
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
    expect([...reachableFrom("ready", ALL_ACTORS)].sort()).toEqual(
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
        reachableFrom(node.id, ALL_ACTORS).has("recorded"),
        `${node.id} cannot end`,
      ).toBe(true);
    }
  });

  test("only the declared provider-wait cannot end without the provider", () => {
    const stuckWithoutProvider = REFUND_NODES.filter(
      ({ id }) => !reachableFrom(id, WITHOUT_PROVIDER).has("recorded"),
    ).map(({ id }) => id);
    const declaredWaits = REFUND_NODES.filter(
      ({ awaits }) => awaits === "provider",
    ).map(({ id }) => id);
    // The two lists must match exactly: a node that needs the provider to
    // finish must say so, and a node that says so must really need it.
    expect(stuckWithoutProvider).toEqual(declaredWaits);
    expect(declaredWaits).toEqual(["check"]);
  });

  test("the entering-events map matches the table", () => {
    for (const attention of ATTENTION_NODES) {
      for (const enter of ENTERING_EVENTS[attention]) {
        const landsThere = REFUND_NODES.some((node) =>
          node.reps.some(
            ({ tag }) =>
              REFUND_MOVES.expected(node.id, enter, tag) === attention,
          ),
        );
        expect(landsThere, `${enter} never lands on ${attention}`).toBe(true);
      }
    }
  });

  test("an exit out of an attention state changes the condition it entered on", () => {
    let checkedExits = 0;
    for (const attentionId of ATTENTION_NODES) {
      for (const { event, source, tag } of declaredExits(
        nodeById(attentionId),
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

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type ModalSnapshot,
  modalEvents,
  modalLifecycleFacts,
  modalSnapshot,
} from "#scripts/verify-models/modal-lifecycle.ts";
import {
  type ModalState,
  transitionModals,
} from "#src/ui/client/admin/modal-state.ts";
import {
  closeFirstWindowEdge,
  edgeFixture,
  expandedWindow,
  forgottenSaveEdge,
  type ModalWitness,
  modalFactsWithFault,
  reversedSurvivorsEdge,
  snapshotFixture,
  snapshotFromEdge,
  threeWindowStack,
  witnessFacts,
} from "#test-utils/modal-lifecycle.ts";

const before = (edge: ModalWitness): ModalSnapshot =>
  snapshotFromEdge(edge, "before");
const after = (edge: ModalWitness): ModalSnapshot =>
  snapshotFromEdge(edge, "after");

/** Turn a fact back into reducer inputs to test the production linkage. This
 * is not the safety oracle: the independent lifecycle laws live in TLA. */
const statesOf = (snapshot: ModalSnapshot): readonly ModalState[] => {
  const locations = [
    ["a", snapshot.aRank, snapshot.aPoint, snapshot.aSaved],
    ["b", snapshot.bRank, snapshot.bPoint, snapshot.bSaved],
    ["c", snapshot.cRank, 0, -1],
  ] as const;
  const states = locations.flatMap(([key, rank, position, saved]) =>
    rank === 0
      ? []
      : [
          {
            expandedPoint: saved === -1 ? null : { left: saved, top: saved },
            key,
            point: { left: position, top: position },
            rank,
          },
        ],
  );
  return states.sort((a, b) => a.rank - b.rank);
};

describe("modal lifecycle production facts", () => {
  test("covers the full small domain and every event, including unchanged outcomes", () => {
    const facts = witnessFacts(modalLifecycleFacts());
    // A has six position/saved modes, B two, and C one. Count each key subset
    // with all its stack permutations, including the empty stack.
    expect(facts.snapshots).toHaveLength(
      1 + 6 + 2 + 1 + 2 * (6 * 2 + 6 + 2) + 6 * 6 * 2,
    );
    expect(modalEvents).toHaveLength(19);
    expect(facts.edges).toHaveLength(
      facts.snapshots.length * modalEvents.length,
    );
    for (const snapshot of facts.snapshots) {
      const outgoing = facts.edges.filter(
        (edge) => JSON.stringify(before(edge)) === JSON.stringify(snapshot),
      );
      expect(outgoing.map((edge) => edge.event)).toEqual(
        modalEvents.map((_, index) => index),
      );
    }
    expect(new Set(facts.edges.map((edge) => edge.kind))).toEqual(
      new Set([
        "open",
        "raise",
        "close",
        "minimise",
        "restore",
        "move",
        "resize",
      ]),
    );
    expect(facts.edges).toContainEqual(
      edgeFixture(snapshotFixture(), snapshotFixture(), {
        event: 3,
        key: "a",
        kind: "close",
      }),
    );
    const collapsed = snapshotFixture({ aPoint: 0, aRank: 1, aSaved: 0 });
    expect(facts.edges).toContainEqual(
      edgeFixture(collapsed, collapsed, {
        event: 4,
        key: "a",
        kind: "minimise",
      }),
    );
  });

  test("normalizes all production calls into complete node and event links", () => {
    const facts = modalLifecycleFacts();
    expect(facts.snapshots[0]).toEqual({ ...snapshotFixture(), id: 0 });
    expect(facts.snapshots.map((row) => row.id)).toEqual(
      facts.snapshots.map((_, index) => index),
    );
    expect(facts.events.map((row) => row.event)).toEqual(
      modalEvents.map((_, index) => index),
    );
    for (const edge of facts.edges) {
      expect(Object.keys(edge).sort()).toEqual(["event", "source", "target"]);
    }
    expect(witnessFacts(facts).edges).toHaveLength(122 * 19);
  });

  test("every edge is an actual reducer call with complete source and target joins", () => {
    const facts = witnessFacts(modalLifecycleFacts());
    const snapshots = facts.snapshots;
    for (const edge of facts.edges) {
      expect(snapshots).toContainEqual(before(edge));
      expect(snapshots).toContainEqual(after(edge));
      const event = modalEvents[edge.event];
      if (event === undefined)
        throw new Error(`Missing modal event ${edge.event}`);
      const observed = transitionModals(statesOf(before(edge)), event);
      expect(modalSnapshot(observed)).toEqual(after(edge));
    }
  });

  test("all declared states are reachable from empty through the supplied edges", () => {
    const facts = witnessFacts(modalLifecycleFacts());
    const reached = new Set([JSON.stringify(modalSnapshot([]))]);
    for (let count = -1; count !== reached.size; ) {
      count = reached.size;
      for (const edge of facts.edges) {
        if (reached.has(JSON.stringify(before(edge))))
          reached.add(JSON.stringify(after(edge)));
      }
    }
    expect(reached).toEqual(
      new Set(facts.snapshots.map((snapshot) => JSON.stringify(snapshot))),
    );
  });

  test("retains the minimise, drag, raise, resize, restore, close and reopen interleaving", () => {
    const facts = witnessFacts(modalLifecycleFacts());
    let snapshot = modalSnapshot([]);
    const sequence = [1, 9, 4, 7, 2, 17, 6, 3, 0];
    for (const event of sequence) {
      const edge = facts.edges.find(
        (row) =>
          row.event === event &&
          JSON.stringify(before(row)) === JSON.stringify(snapshot),
      );
      if (edge === undefined)
        throw new Error(`Missing lifecycle edge for event ${event}`);
      snapshot = after(edge);
    }
    expect(snapshot).toEqual(
      snapshotFixture({ aPoint: 0, aRank: 2, bPoint: 0, bRank: 1 }),
    );
    expect(facts.edges).toContainEqual(
      edgeFixture(
        snapshotFixture({ aPoint: 0, aRank: 1, aSaved: 2 }),
        snapshotFixture({ aPoint: 2, aRank: 1 }),
        { event: 6, key: "a", kind: "restore", limit: 2 },
      ),
    );
    expect(facts.edges).toContainEqual(
      edgeFixture(
        snapshotFixture({
          aPoint: 2,
          aRank: 1,
          aSaved: 0,
          bPoint: 0,
          bRank: 2,
        }),
        snapshotFixture({
          aPoint: 2,
          aRank: 2,
          aSaved: 0,
          bPoint: 0,
          bRank: 1,
        }),
        { event: 0, input: 0, key: "a", kind: "open" },
      ),
    );
  });

  test("producer-level forgotten-save fault reaches facts rather than being filtered", () => {
    let calls = 0;
    const faulty = modalFactsWithFault((next, _states, event) => {
      calls++;
      if (event.type !== "minimise") return next;
      return next.map((state) =>
        state.key === event.key
          ? { ...state, expandedPoint: { left: 0, top: 0 } }
          : state,
      );
    });
    expect(calls).toBe(faulty.edges.length);
    expect(faulty.edges).toContainEqual(forgottenSaveEdge);
  });

  test("close keeps two survivors in order and a real reverse-survivors fault reaches facts", () => {
    const clean = witnessFacts(modalLifecycleFacts());
    expect(clean.edges).toContainEqual(closeFirstWindowEdge);
    expect(clean.edges).toContainEqual(
      edgeFixture(
        threeWindowStack,
        snapshotFixture({ aPoint: 0, aRank: 1, cRank: 2 }),
        { event: 11, key: "b", kind: "close" },
      ),
    );
    const faulty = modalFactsWithFault((next, states, event) =>
      event.type === "close" && states.length === 3
        ? [...next].reverse()
        : next,
    );
    expect(faulty.edges).toContainEqual(reversedSurvivorsEdge);
  });

  test("projection fails on evidence outside the stated three-key domain", () => {
    const invalid = [
      [[expandedWindow("a", 0, 1)], "left its diagonal"],
      [[expandedWindow("other")], "Unknown modal identity"],
      [[expandedWindow("a"), expandedWindow("a")], "Duplicate modal identity"],
      [[expandedWindow("c", 2)], "Stack-only modal changed"],
      [
        [{ ...expandedWindow("c"), expandedPoint: { left: 0, top: 0 } }],
        "Stack-only modal changed",
      ],
    ] as const;
    for (const [states, message] of invalid) {
      expect(() => modalSnapshot(states)).toThrow(message);
    }
    expect(() =>
      modalFactsWithFault((next) =>
        next.map((state) =>
          state.key === "a"
            ? {
                ...state,
                point: { left: state.point.left + 1, top: state.point.top + 1 },
              }
            : state,
        ),
      ),
    ).toThrow("not finite as declared");
  });
});

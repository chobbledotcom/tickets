import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundAuthorityAtlas } from "#shared/schema-atlas/refund-authority.ts";
import { indexMachine } from "#test/shared/schema-atlas/helpers.ts";

const { byId, edgeIds, machine } = indexMachine(refundAuthorityAtlas());

/** Every state id reachable from the start, following declared edges. */
const reachableFromStart = (): Set<string> => {
  const seen = new Set<string>(["ready"]);
  const queue = ["ready"];
  for (let index = 0; index < queue.length; index++) {
    for (const edge of byId.get(queue[index]!)!.edges) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return seen;
};

describe("the refund authority atlas", () => {
  test("declares its identity, keys, and every node's place on the map", () => {
    expect(machine.id).toBe("refund");
    expect(machine.titleKey).toBe("schema.refund.title");
    expect(machine.introKey).toBe("schema.refund.intro");
    expect(
      machine.states.map(({ id, labelKey, layout }) => ({
        id,
        labelKey,
        layout,
      })),
    ).toEqual([
      {
        id: "ready",
        labelKey: "schema.refund.state.ready",
        layout: { x: 110, y: 250 },
      },
      {
        id: "send_armed",
        labelKey: "schema.refund.state.send_armed",
        layout: { x: 370, y: 110 },
      },
      {
        id: "observing",
        labelKey: "schema.refund.state.observing",
        layout: { x: 640, y: 110 },
      },
      {
        id: "check",
        labelKey: "schema.refund.state.check",
        layout: { x: 900, y: 250 },
      },
      {
        id: "choice_open",
        labelKey: "schema.refund.state.choice_open",
        layout: { x: 370, y: 400 },
      },
      {
        id: "choice_not_sent",
        labelKey: "schema.refund.state.choice_not_sent",
        layout: { x: 370, y: 540 },
      },
      {
        id: "choice_returned",
        labelKey: "schema.refund.state.choice_returned",
        layout: { x: 640, y: 400 },
      },
      {
        id: "returned",
        labelKey: "schema.refund.state.returned",
        layout: { x: 640, y: 540 },
      },
      {
        id: "recorded",
        labelKey: "schema.refund.state.recorded",
        layout: { x: 900, y: 540 },
      },
    ]);
  });

  test("declares exactly one start state and every state is reachable", () => {
    const starts = machine.states.filter((state) => state.start === true);
    expect(starts.map((state) => state.id)).toEqual(["ready"]);
    expect([...reachableFromStart()].sort()).toEqual(
      machine.states.map((state) => state.id).sort(),
    );
  });

  test("every edge names a state the machine declares", () => {
    for (const state of machine.states) {
      for (const edge of state.edges) {
        expect(byId.has(edge.to), `${state.id} -> ${edge.to}`).toBe(true);
      }
    }
  });

  test("the send path runs ready → armed → observing and never re-arms keyless", () => {
    expect(edgeIds("ready")).toEqual([
      "arm=>send_armed",
      "provider_returned=>returned",
      "unreadable=>choice_open",
      "conflict_returned=>choice_returned",
      "conflict_not_sent=>choice_not_sent",
      "conflict_wait=>check",
    ]);
    expect(edgeIds("send_armed")).toContain("observe=>observing");
    expect(edgeIds("send_armed")).toContain("replay=>send_armed");
    expect(edgeIds("send_armed")).toContain("expired=>choice_open");
    expect(edgeIds("send_armed")).toContain("possibly_sent=>choice_open");
    expect(edgeIds("ready")).not.toContain("replay=>send_armed");
  });

  test("a settled partial return is an owner decision with one exit", () => {
    // The dead-end fix, pinned as a map shape: confirming the money that came
    // back is the ONLY way out — no re-check, no not-sent re-arm.
    expect(edgeIds("choice_returned")).toEqual([
      "owner_confirms_returned=>returned",
    ]);
  });

  test("a proved-not-sent conflict offers only the re-arm", () => {
    expect(edgeIds("choice_not_sent")).toEqual([
      "owner_confirms_not_sent=>ready",
    ]);
  });

  test("an inconclusive check stays a check and never offers an owner exit", () => {
    expect(edgeIds("check")).toEqual([
      "provider_returned=>returned",
      "conflict_returned=>choice_returned",
      "conflict_not_sent=>choice_not_sent",
      "conflict_wait=>check",
    ]);
    expect(edgeIds("check").some((edge) => edge.includes("owner"))).toBe(false);
  });

  test("the open owner choice admits both answers and fresh evidence", () => {
    expect(edgeIds("choice_open")).toContain(
      "owner_confirms_returned=>returned",
    );
    expect(edgeIds("choice_open")).toContain("owner_confirms_not_sent=>ready");
    expect(edgeIds("choice_open")).toContain("conflict_wait=>check");
  });

  test("money back ends at recorded, which is terminal", () => {
    expect(edgeIds("returned")).toEqual(["record_in_money=>recorded"]);
    expect(edgeIds("recorded")).toEqual([]);
  });

  test("each actor kind appears, and owner edges exist only from decisions and recording", () => {
    const actors = new Set(
      machine.states.flatMap((state) => state.edges.map((edge) => edge.actor)),
    );
    expect([...actors].sort()).toEqual(["owner", "provider", "system"]);
    // The owner acts only where a decision or a Money recording waits.
    const ownerStates = machine.states
      .filter((state) => state.edges.some((edge) => edge.actor === "owner"))
      .map((state) => state.id);
    expect(ownerStates).toEqual([
      "choice_open",
      "choice_not_sent",
      "choice_returned",
      "returned",
    ]);
  });

  test("carries the lifecycle's own facts for every state", () => {
    for (const state of machine.states) {
      expect(state.facts.map((fact) => fact.labelKey)).toEqual([
        "schema.fact.cleared_by",
        "schema.fact.route",
      ]);
      for (const fact of state.facts) {
        expect(
          fact.value.length,
          `${state.id} ${fact.labelKey}`,
        ).toBeGreaterThan(0);
      }
    }
    expect(byId.get("recorded")!.facts[0]!.value).toBe(
      "markRefundAuthorityRecorded",
    );
    expect(byId.get("choice_returned")!.facts[0]!.value).toBe(
      "resolveProviderRefundCase",
    );
  });
});

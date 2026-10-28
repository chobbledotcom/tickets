import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { TAX_EVENTS, TAX_NODES, taxNodeOf } from "#shared/tax/machine-spec.ts";
import { EXPECTED_MOVES } from "#test/shared/tax/machine-spec/expected-moves.ts";
import { registerConformanceSweep } from "#test-utils/machine-spec.ts";

describe("VAT assessment contract", () => {
  registerConformanceSweep({
    events: TAX_EVENTS,
    moves: EXPECTED_MOVES,
    nodeOf: taxNodeOf,
    nodes: TAX_NODES,
  });

  it("replays and returns A → B → A from the original listed basis", () => {
    const save = TAX_EVENTS.find((event) => event.id === "save");
    if (!save) throw new Error("Missing save event");
    for (const { state } of TAX_NODES[0]!.reps) {
      const initial = structuredClone(state);
      const first = save.run(initial);
      expect(save.run(first)).toEqual(first);
      const back = save.run({
        ...first,
        setting: state.booking.assessment.policy,
      });
      expect(back.booking.assessment).toEqual(state.booking.assessment);
      expect(back.booking.assessment.basis).toEqual(
        state.booking.assessment.basis,
      );
    }
  });
});

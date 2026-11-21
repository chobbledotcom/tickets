import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  TAX_BASES,
  TAX_EVENTS,
  TAX_NODES,
  taxNodeOf,
} from "#shared/tax/machine-spec.ts";
import { EXPECTED_MOVES } from "#test/shared/tax/machine-spec/expected-moves.ts";
import { jsonHash } from "#test-utils/hash.ts";
import { registerConformanceSweep } from "#test-utils/machine-spec.ts";

describe("VAT assessment contract", () => {
  registerConformanceSweep({
    events: TAX_EVENTS,
    moves: EXPECTED_MOVES,
    nodeOf: taxNodeOf,
    nodes: TAX_NODES,
  });

  // The bases and the representative states are declared data. A weaker claim
  // would let a smaller basis or a later start slip past the sweep.
  it("keeps the declared bases and representative states exact", async () => {
    expect(
      await jsonHash({
        bases: TAX_BASES,
        events: TAX_EVENTS,
        nodes: TAX_NODES,
      }),
    ).toBe("20fbcacd66b0d50f0d1537c330c83ac0bfa88491fdddbb8a86ab92e65b1d8dcc");
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

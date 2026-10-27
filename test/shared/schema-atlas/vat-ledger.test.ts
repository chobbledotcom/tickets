import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { movesIn } from "#shared/schema-atlas/machine-spec.ts";
import { vatLedgerAtlas } from "#shared/schema-atlas/vat-ledger.ts";
import { TAX_EVENTS, TAX_MOVES, TAX_NODES } from "#shared/tax/machine-spec.ts";

describe("VAT atlas graph", () => {
  it("draws exactly the independently declared accepted moves", () => {
    for (const node of TAX_NODES) {
      const drawn = vatLedgerAtlas.states.find((state) => state.id === node.id);
      if (!drawn) throw new Error("Missing VAT state");
      const expected = TAX_EVENTS.flatMap((event) => {
        const target = movesIn(TAX_MOVES).expected(node.id, event.id, "");
        return target === "refused"
          ? []
          : [{ actor: event.actor, labelKey: event.labelKey, to: target }];
      });
      expect(drawn.edges).toEqual(expected);
    }
  });

  it("keeps settings independent and cannot reopen a refunded assessment", () => {
    for (const state of vatLedgerAtlas.states) {
      expect(
        state.edges
          .filter((edge) => edge.labelKey.includes(".setting_"))
          .every((edge) => edge.to === state.id),
      ).toBe(true);
      if (state.id === "refunded")
        expect(state.edges.every((edge) => edge.to === "refunded")).toBe(true);
      expect(state.edges.some((edge) => edge.labelKey.endsWith("_stale"))).toBe(
        false,
      );
    }
  });
});

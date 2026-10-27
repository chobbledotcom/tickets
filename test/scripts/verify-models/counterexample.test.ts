/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  corruptOneEdge,
  counterexampleData,
} from "#scripts/verify-models/counterexample.ts";
import {
  modelData,
  type PaymentModel,
  paymentModel,
} from "#scripts/verify-models/model.ts";
import { requireValue } from "#shared/required-value.ts";
import { records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

describe("corrupted edge counterexample", () => {
  test("changes the request of one emitted money edge", async () => {
    const model = await paymentModel();
    const honest = records(modelData(model), "AuthMoves");
    const data = await counterexampleData();
    const corrupted = records(data, "AuthMoves");
    expect(data).toBe(modelData(corruptOneEdge(model)));
    expect(corrupted).toHaveLength(honest.length);
    const changed = honest.flatMap((move, index) => {
      const after = corrupted[index];
      if (after === undefined || after.requestKept === move.requestKept) {
        return [];
      }
      return [{ after, before: move }];
    });
    expect(changed).toHaveLength(1);
    const edge = requireValue(changed[0], "No changed money edge");
    expect(model.moneyEventIds).toContain(edge.before.eventId);
    expect(edge.before.requestKept).toBe(true);
    expect(edge.after).toEqual({ ...edge.before, requestKept: false });
  });

  test("throws when no money edge carries a preserved request", () => {
    const bare: PaymentModel = {
      authorityMoves: [],
      authorityStates: ["absent"],
      claimedRows: [],
      claimMirror: "",
      moneyEventIds: [],
      prunableStates: [],
      rowMoves: [],
      rowStart: "none",
      rowStates: [],
      sendAuthorityNames: [],
    };
    expect(() => corruptOneEdge(bare)).toThrow(
      "no money edge with a preserved request",
    );
  });
});

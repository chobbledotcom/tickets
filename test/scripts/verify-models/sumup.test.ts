/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  RECOVERY_EVENTS,
  RECOVERY_MOVES,
  RECOVERY_NODES,
  recoveryRowAfter,
} from "#payment/sumup-recovery-machine-spec.ts";
import { sumupModelData } from "#scripts/verify-models/sumup.ts";
import { requireValue } from "#shared/required-value.ts";
import { members, records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

describe("SumUp recovery checker data", () => {
  test("keeps paid evidence separate from money that can be pruned", async () => {
    const data = await sumupModelData();
    const facts = records(data, "RecoveryNodeFacts");

    expect(facts).toContainEqual({
      moneyOwed: "yes",
      prunable: false,
      state: "owed",
    });
    expect(facts).toContainEqual({
      moneyOwed: "unknown",
      prunable: false,
      state: "waiting",
    });
    expect(facts).toContainEqual({
      moneyOwed: "no",
      prunable: true,
      state: "finished",
    });
    expect(facts).toContainEqual({
      moneyOwed: "no",
      prunable: true,
      state: "unpaid",
    });
    expect(facts).toContainEqual({
      moneyOwed: "no",
      prunable: true,
      state: "staged",
    });
    expect(members(data, "PrunableStates")).toEqual(
      expect.arrayContaining(["staged", "unpaid", "finished"]),
    );
    expect(members(data, "PrunableStates")).not.toEqual(
      expect.arrayContaining(["owed"]),
    );
    expect(members(data, "PrunableStates")).not.toEqual(
      expect.arrayContaining(["waiting"]),
    );
  });

  test("carries checkout id presence and reader agreement into live moves", async () => {
    const data = await sumupModelData();
    const representatives = records(data, "RecoveryRepresentatives");
    const moves = records(data, "RecoveryMoves");

    expect(representatives).toContainEqual({
      checkoutIdAgrees: true,
      declaredState: "staged",
      hasCheckoutId: false,
      sampleTag: "no_checkout_id",
      storedState: "staged",
    });
    expect(representatives).toContainEqual({
      checkoutIdAgrees: true,
      declaredState: "waiting",
      hasCheckoutId: true,
      sampleTag: "live_checkout",
      storedState: "waiting",
    });
    expect(moves).toContainEqual({
      eventId: "checkout_created",
      sampleTag: "no_checkout_id",
      sourceHasCheckoutId: false,
      sourceState: "staged",
      targetCheckoutIdAgrees: true,
      targetHasCheckoutId: true,
      targetState: "waiting",
    });
    expect(moves).toContainEqual({
      eventId: "read_paid_settled",
      sampleTag: "live_checkout",
      sourceHasCheckoutId: true,
      sourceState: "waiting",
      targetCheckoutIdAgrees: true,
      targetHasCheckoutId: true,
      targetState: "finished",
    });
    expect(moves).toContainEqual({
      eventId: "read_paid_unsettled",
      sampleTag: "live_checkout",
      sourceHasCheckoutId: true,
      sourceState: "waiting",
      targetCheckoutIdAgrees: true,
      targetHasCheckoutId: true,
      targetState: "owed",
    });
    expect(moves).toContainEqual({
      eventId: "read_paid_unreadable",
      sampleTag: "live_checkout",
      sourceHasCheckoutId: true,
      sourceState: "waiting",
      targetCheckoutIdAgrees: true,
      targetHasCheckoutId: true,
      targetState: "waiting",
    });
    expect(members(data, "RecoveryStates")).toEqual(
      expect.arrayContaining(["staged", "waiting", "owed", "finished"]),
    );
  });

  test("classifies reads as checks without classifying checkout creation", async () => {
    const data = await sumupModelData();
    const checks = members(data, "CheckEvents");
    expect(checks).toEqual(
      expect.arrayContaining([
        "read_paid_settled",
        "read_paid_unsettled",
        "read_paid_booked",
        "read_paid_contradiction",
        "read_paid_unreadable",
        "read_pending",
        "read_expired_or_failed",
        "read_unavailable",
      ]),
    );
    expect(checks).not.toContain("checkout_created");
    expect(members(data, "CheckableStates")).toEqual(
      expect.arrayContaining(["waiting", "owed"]),
    );
    expect(members(data, "CheckableStates")).not.toContain("staged");
    expect(members(data, "CheckableStates")).not.toContain("finished");
    expect(members(data, "CheckableStates")).not.toContain("unpaid");
  });

  test("omits refusals and continues through later representatives and events", async () => {
    const moves = records(await sumupModelData(), "RecoveryMoves");
    expect(moves.some((move) => move.sourceState === "finished")).toBe(false);
    expect(moves.some((move) => move.sourceState === "unpaid")).toBe(false);
    expect(
      moves.some(
        (move) =>
          move.sourceState === "staged" && move.eventId === "read_pending",
      ),
    ).toBe(false);
    expect(
      moves.some(
        (move) =>
          move.sourceState === "owed" && move.eventId === "read_pending",
      ),
    ).toBe(false);
    expect(moves).toContainEqual({
      eventId: "read_unavailable",
      sampleTag: "unaccounted_for",
      sourceHasCheckoutId: true,
      sourceState: "owed",
      targetCheckoutIdAgrees: true,
      targetHasCheckoutId: true,
      targetState: "owed",
    });
  });

  test("preserves a checkout-id-free output from an allowed live transition", async () => {
    // A temporary no-id self-loop exercises the output fact with the real reader.
    const original = Object.getOwnPropertyDescriptor(
      RECOVERY_MOVES.staged,
      "read_pending",
    );
    Object.defineProperty(RECOVERY_MOVES.staged, "read_pending", {
      configurable: true,
      value: "staged",
    });
    try {
      expect(records(await sumupModelData(), "RecoveryMoves")).toContainEqual({
        eventId: "read_pending",
        sampleTag: "no_checkout_id",
        sourceHasCheckoutId: false,
        sourceState: "staged",
        targetCheckoutIdAgrees: true,
        targetHasCheckoutId: false,
        targetState: "staged",
      });
    } finally {
      if (original) {
        Object.defineProperty(RECOVERY_MOVES.staged, "read_pending", original);
      } else {
        Reflect.deleteProperty(RECOVERY_MOVES.staged, "read_pending");
      }
    }
  });

  test("records checkout id disagreement instead of inventing reader evidence", async () => {
    const node = RECOVERY_NODES.find((node) => node.id === "finished");
    if (!node) throw new Error("Missing finished recovery fixture");
    const row = requireValue(
      node.reps[0],
      "Missing finished recovery representative",
    ).state;
    const original = Object.getOwnPropertyDescriptor(row, "sumupId");
    if (!original) throw new Error("Missing checkout id fixture property");
    Object.defineProperty(row, "sumupId", { ...original, value: "" });
    try {
      expect(
        records(await sumupModelData(), "RecoveryRepresentatives"),
      ).toContainEqual({
        checkoutIdAgrees: false,
        declaredState: "finished",
        hasCheckoutId: false,
        sampleTag: "accounted_for",
        storedState: "finished",
      });
    } finally {
      Object.defineProperty(row, "sumupId", original);
    }
  });

  test("aborts when a declared move fails to write the required checkout id", async () => {
    const created = RECOVERY_EVENTS.find(
      (event) => event.id === "checkout_created",
    );
    if (!created) throw new Error("Missing checkout creation fixture");
    using _run = stub(created, "run", (row) =>
      recoveryRowAfter(row, "checkout_created", ""),
    );

    await expect(sumupModelData()).rejects.toThrow(
      "A sumup_checkouts row cannot be waiting with no checkout id",
    );
  });
});

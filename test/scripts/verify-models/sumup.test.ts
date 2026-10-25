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
import { members, tuples } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

describe("SumUp recovery checker data", () => {
  test("keeps paid evidence separate from money that can be pruned", async () => {
    const data = await sumupModelData();
    const facts = tuples(data, "RecoveryNodeFacts");

    expect(facts).toContainEqual(["owed", "yes", false]);
    expect(facts).toContainEqual(["waiting", "unknown", false]);
    expect(facts).toContainEqual(["finished", "no", true]);
    expect(facts).toContainEqual(["unpaid", "no", true]);
    expect(facts).toContainEqual(["staged", "no", true]);
    expect(members(data, "PrunableStates")).toEqual(
      expect.arrayContaining(["staged", "unpaid", "finished"]),
    );
    expect(members(data, "PrunableStates")).not.toEqual(
      expect.arrayContaining(["owed"]),
    );
    expect(members(data, "PrunableStates")).not.toEqual(
      expect.arrayContaining(["waiting"]),
    );
    expect(data).toMatch(/\bTRUE\b/);
    expect(data).toMatch(/\bFALSE\b/);
    expect(data).not.toMatch(/\b(?:true|false)\b/);
  });

  test("carries checkout id presence and reader agreement into live moves", async () => {
    const data = await sumupModelData();
    const representatives = tuples(data, "RecoveryRepresentatives");
    const moves = tuples(data, "RecoveryMoves");

    expect(data).toContain('NoCheckoutIdState == "staged"');
    expect(representatives).toContainEqual([
      "staged",
      "no_checkout_id",
      "staged",
      false,
      true,
    ]);
    expect(representatives).toContainEqual([
      "waiting",
      "live_checkout",
      "waiting",
      true,
      true,
    ]);
    expect(moves).toContainEqual([
      "staged",
      "no_checkout_id",
      false,
      "checkout_created",
      "waiting",
      true,
      true,
    ]);
    expect(moves).toContainEqual([
      "waiting",
      "live_checkout",
      true,
      "read_paid_settled",
      "finished",
      true,
      true,
    ]);
    expect(moves).toContainEqual([
      "waiting",
      "live_checkout",
      true,
      "read_paid_unsettled",
      "owed",
      true,
      true,
    ]);
    expect(moves).toContainEqual([
      "waiting",
      "live_checkout",
      true,
      "read_paid_unreadable",
      "waiting",
      true,
      true,
    ]);
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
    const moves = tuples(await sumupModelData(), "RecoveryMoves");
    expect(moves.some(([source]) => source === "finished")).toBe(false);
    expect(moves.some(([source]) => source === "unpaid")).toBe(false);
    expect(
      moves.some(
        ([source, , , event]) =>
          source === "staged" && event === "read_pending",
      ),
    ).toBe(false);
    expect(
      moves.some(
        ([source, , , event]) => source === "owed" && event === "read_pending",
      ),
    ).toBe(false);
    expect(moves).toContainEqual([
      "owed",
      "unaccounted_for",
      true,
      "read_unavailable",
      "owed",
      true,
      true,
    ]);
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
      expect(tuples(await sumupModelData(), "RecoveryMoves")).toContainEqual([
        "staged",
        "no_checkout_id",
        false,
        "read_pending",
        "staged",
        false,
        true,
      ]);
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
        tuples(await sumupModelData(), "RecoveryRepresentatives"),
      ).toContainEqual(["finished", "accounted_for", "finished", false, false]);
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

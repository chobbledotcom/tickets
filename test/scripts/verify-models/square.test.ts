/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  LINK_END_EVENTS,
  LINK_END_NODES,
} from "#payment/square-link-end-machine-spec.ts";
import { squareModelData } from "#scripts/verify-models/square.ts";
import { requireValue } from "#shared/required-value.ts";
import { members, tuples } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

const eventOf = (id: string) =>
  requireValue(
    LINK_END_EVENTS.find((event) => event.id === id),
    `Missing event ${id}`,
  );

const representativeOf = (id: string) =>
  requireValue(
    requireValue(
      LINK_END_NODES.find((node) => node.id === id),
      `Missing node ${id}`,
    ).reps[0],
    `Missing representative ${id}`,
  );

describe("Square link end checker data", () => {
  test("records real accepted transitions and unchanged refused attempts", async () => {
    const data = await squareModelData();
    const attempts = tuples(data, "LinkAttempts");
    expect(attempts).toContainEqual([
      "unwritten",
      "checkout_created",
      "pending",
      "no_row_yet",
      true,
    ]);
    expect(attempts).toContainEqual([
      "pending",
      "claim_due",
      "ending",
      "unclaimed",
      true,
    ]);
    expect(attempts).toContainEqual([
      "ending",
      "delete_inconclusive",
      "pending",
      "lease_held",
      true,
    ]);
    expect(attempts).toContainEqual([
      "ending",
      "lease_expired",
      "pending",
      "lease_held",
      true,
    ]);
    expect(attempts).toContainEqual([
      "pending",
      "delete_answered_cancelled",
      "pending",
      "unclaimed",
      false,
    ]);
    expect(attempts).toContainEqual([
      "ending",
      "payment_completed",
      "ending",
      "lease_held",
      false,
    ]);
    expect(attempts).toContainEqual([
      "gone",
      "checkout_created",
      "gone",
      "row_deleted",
      false,
    ]);
    expect(members(data, "HandleStates")).toContain("pending");
    expect(members(data, "HandleStates")).not.toContain("gone");
    expect(members(data, "CheckableStates")).toContain("ending");
    expect(members(data, "CheckableStates")).not.toContain("unwritten");
    expect(tuples(data, "LinkEvents")).toContainEqual([
      "checkout_created",
      "create",
      false,
    ]);
    expect(tuples(data, "LinkEvents")).toContainEqual([
      "payment_completed",
      "complete",
      false,
    ]);
    expect(data).toMatch(/\bTRUE\b/);
    expect(data).toMatch(/\bFALSE\b/);
    expect(data).not.toMatch(/\b(?:true|false)\b/);
  });

  test("does not turn a failed required move into a refusal", async () => {
    const failure = new Error("required Square move failed");
    using _run = stub(eventOf("claim_due"), "run", () => {
      throw failure;
    });
    await expect(squareModelData()).rejects.toThrow(failure.message);
  });

  test("keeps successful tampered refusals and mutated transition outputs visible", async () => {
    const representative = representativeOf("pending");
    const originalState = representative.state.state;
    using _run = stub(eventOf("delete_inconclusive"), "run", (row) => {
      // Mutate the argument as well as returning it: source evidence and the
      // next event must still come from an untouched representative.
      Object.assign(row, { state: "gone" });
      return row;
    });
    const data = await squareModelData();
    const attempts = tuples(data, "LinkAttempts");
    expect(attempts).toContainEqual([
      "pending",
      "delete_inconclusive",
      "gone",
      "unclaimed",
      true,
    ]);
    expect(attempts).toContainEqual([
      "ending",
      "delete_inconclusive",
      "gone",
      "lease_held",
      true,
    ]);
    expect(attempts).toContainEqual([
      "pending",
      "payment_completed",
      "gone",
      "unclaimed",
      true,
    ]);
    expect(tuples(data, "LinkRepresentatives")).toContainEqual([
      "pending",
      "unclaimed",
      "pending",
    ]);
    expect(representative.state.state).toBe(originalState);
  });

  test("retains the source even if a refused attempt mutates before throwing", async () => {
    const created = eventOf("checkout_created");
    const original = created.run;
    using _run = stub(created, "run", (row) => {
      if (row.state === "pending") {
        Object.assign(row, { state: "gone" });
        throw new Error("still refused");
      }
      return original(row);
    });
    expect(tuples(await squareModelData(), "LinkAttempts")).toContainEqual([
      "pending",
      "checkout_created",
      "pending",
      "unclaimed",
      false,
    ]);
    expect(representativeOf("pending").state.state).toBe("pending");
  });

  test("does not replace representative state or money flags with expected values", async () => {
    const row = representativeOf("gone").state;
    const event = eventOf("claim_due");
    const stateDescriptor = requireValue(
      Object.getOwnPropertyDescriptor(row, "state"),
      "Missing state property",
    );
    const moneyDescriptor = requireValue(
      Object.getOwnPropertyDescriptor(event, "movesMoney"),
      "Missing money property",
    );
    Object.defineProperty(row, "state", {
      ...stateDescriptor,
      value: "pending",
    });
    Object.defineProperty(event, "movesMoney", {
      ...moneyDescriptor,
      value: true,
    });
    try {
      const data = await squareModelData();
      expect(tuples(data, "LinkRepresentatives")).toContainEqual([
        "gone",
        "row_deleted",
        "pending",
      ]);
      expect(tuples(data, "LinkEvents")).toContainEqual([
        "claim_due",
        "check",
        true,
      ]);
      expect(tuples(data, "LinkAttempts")).toContainEqual([
        "pending",
        "claim_due",
        "ending",
        "row_deleted",
        true,
      ]);
    } finally {
      Object.defineProperty(row, "state", stateDescriptor);
      Object.defineProperty(event, "movesMoney", moneyDescriptor);
    }
  });

  test("executes raw replies while retaining independent external evidence", async () => {
    const facts = tuples(await squareModelData(), "ReplyFacts");
    expect(facts).toContainEqual([
      "cancelled",
      "cancelled",
      "delete_answered_cancelled",
    ]);
    expect(facts).toContainEqual([
      "missing",
      "missing",
      "delete_answered_missing",
    ]);
    expect(facts).toContainEqual(["completed", "paid", "delete_refused_paid"]);
    expect(facts).toContainEqual(["paid", "paid", "delete_refused_paid"]);
    for (const witness of [
      "success_without_id",
      "unreadable",
      "unpaid",
      "unrelated_failure",
    ]) {
      expect(facts).toContainEqual([witness, "none", "delete_inconclusive"]);
    }
  });

  test("distinguishes native expiry from the strict retention boundary", async () => {
    const facts = tuples(await squareModelData(), "AgeFacts");
    expect(facts).toContainEqual(["native_before", true, false, false]);
    expect(facts).toContainEqual(["native_at", false, false, false]);
    expect(facts).toContainEqual(["retention_before", false, false, false]);
    expect(facts).toContainEqual(["retention_at", false, false, false]);
    expect(facts).toContainEqual(["retention_after", false, true, true]);
  });

  test("allows time to cross safety boundaries without moving backwards", async () => {
    const moves = tuples(await squareModelData(), "AgeMoves");
    for (const later of ["native_at", "retention_at", "margin_after"]) {
      expect(moves).toContainEqual(["zero", later]);
    }
    expect(moves).not.toContainEqual(["margin_after", "zero"]);
    expect(moves).not.toContainEqual(["native_at", "native_before"]);
  });
});

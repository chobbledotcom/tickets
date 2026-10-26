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
import { members, records } from "#test-utils/tla-data.ts";

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
    const attempts = records(data, "LinkAttempts");
    expect(attempts).toContainEqual({
      accepted: true,
      eventId: "checkout_created",
      sampleTag: "no_row_yet",
      sourceState: "unwritten",
      targetState: "pending",
    });
    expect(attempts).toContainEqual({
      accepted: true,
      eventId: "claim_due",
      sampleTag: "unclaimed",
      sourceState: "pending",
      targetState: "ending",
    });
    expect(attempts).toContainEqual({
      accepted: true,
      eventId: "delete_inconclusive",
      sampleTag: "lease_held",
      sourceState: "ending",
      targetState: "pending",
    });
    expect(attempts).toContainEqual({
      accepted: true,
      eventId: "lease_expired",
      sampleTag: "lease_held",
      sourceState: "ending",
      targetState: "pending",
    });
    expect(attempts).toContainEqual({
      accepted: false,
      eventId: "delete_answered_cancelled",
      sampleTag: "unclaimed",
      sourceState: "pending",
      targetState: "pending",
    });
    expect(attempts).toContainEqual({
      accepted: false,
      eventId: "payment_completed",
      sampleTag: "lease_held",
      sourceState: "ending",
      targetState: "ending",
    });
    expect(attempts).toContainEqual({
      accepted: false,
      eventId: "checkout_created",
      sampleTag: "row_deleted",
      sourceState: "gone",
      targetState: "gone",
    });
    expect(members(data, "HandleStates")).toContain("pending");
    expect(members(data, "HandleStates")).not.toContain("gone");
    expect(members(data, "CheckableStates")).toContain("ending");
    expect(members(data, "CheckableStates")).not.toContain("unwritten");
    expect(records(data, "LinkEvents")).toContainEqual({
      eventId: "checkout_created",
      kind: "create",
      movesMoney: false,
    });
    expect(records(data, "LinkEvents")).toContainEqual({
      eventId: "payment_completed",
      kind: "complete",
      movesMoney: false,
    });
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
    const attempts = records(data, "LinkAttempts");
    expect(attempts).toContainEqual({
      accepted: true,
      eventId: "delete_inconclusive",
      sampleTag: "unclaimed",
      sourceState: "pending",
      targetState: "gone",
    });
    expect(attempts).toContainEqual({
      accepted: true,
      eventId: "delete_inconclusive",
      sampleTag: "lease_held",
      sourceState: "ending",
      targetState: "gone",
    });
    expect(attempts).toContainEqual({
      accepted: true,
      eventId: "payment_completed",
      sampleTag: "unclaimed",
      sourceState: "pending",
      targetState: "gone",
    });
    expect(records(data, "LinkRepresentatives")).toContainEqual({
      declaredState: "pending",
      sampleTag: "unclaimed",
      storedState: "pending",
    });
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
    expect(records(await squareModelData(), "LinkAttempts")).toContainEqual({
      accepted: false,
      eventId: "checkout_created",
      sampleTag: "unclaimed",
      sourceState: "pending",
      targetState: "pending",
    });
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
      expect(records(data, "LinkRepresentatives")).toContainEqual({
        declaredState: "gone",
        sampleTag: "row_deleted",
        storedState: "pending",
      });
      expect(records(data, "LinkEvents")).toContainEqual({
        eventId: "claim_due",
        kind: "check",
        movesMoney: true,
      });
      expect(records(data, "LinkAttempts")).toContainEqual({
        accepted: true,
        eventId: "claim_due",
        sampleTag: "row_deleted",
        sourceState: "pending",
        targetState: "ending",
      });
    } finally {
      Object.defineProperty(row, "state", stateDescriptor);
      Object.defineProperty(event, "movesMoney", moneyDescriptor);
    }
  });

  test("executes raw replies while retaining independent external evidence", async () => {
    const facts = records(await squareModelData(), "ReplyFacts");
    expect(facts).toContainEqual({
      eventId: "delete_answered_cancelled",
      expectedEvidence: "cancelled",
      sampleTag: "cancelled",
    });
    expect(facts).toContainEqual({
      eventId: "delete_answered_missing",
      expectedEvidence: "missing",
      sampleTag: "missing",
    });
    for (const sampleTag of ["completed", "paid"]) {
      expect(facts).toContainEqual({
        eventId: "delete_refused_paid",
        expectedEvidence: "paid",
        sampleTag,
      });
    }
    for (const witness of [
      "success_without_id",
      "unreadable",
      "unpaid",
      "unrelated_failure",
    ]) {
      expect(facts).toContainEqual({
        eventId: "delete_inconclusive",
        expectedEvidence: "none",
        sampleTag: witness,
      });
    }
  });

  test("distinguishes native expiry from the strict retention boundary", async () => {
    const facts = records(await squareModelData(), "AgeFacts");
    expect(facts).toContainEqual({
      ageState: "native_before",
      mayPay: true,
      prunable: false,
      requiredMarginElapsed: false,
    });
    for (const ageState of ["native_at", "retention_before", "retention_at"]) {
      expect(facts).toContainEqual({
        ageState,
        mayPay: false,
        prunable: false,
        requiredMarginElapsed: false,
      });
    }
    expect(facts).toContainEqual({
      ageState: "retention_after",
      mayPay: false,
      prunable: true,
      requiredMarginElapsed: true,
    });
  });

  test("allows time to cross safety boundaries without moving backwards", async () => {
    const moves = records(await squareModelData(), "AgeMoves");
    for (const later of ["native_at", "retention_at", "margin_after"]) {
      expect(moves).toContainEqual({ sourceAge: "zero", targetAge: later });
    }
    expect(moves).not.toContainEqual({
      sourceAge: "margin_after",
      targetAge: "zero",
    });
    expect(moves).not.toContainEqual({
      sourceAge: "native_at",
      targetAge: "native_before",
    });
  });
});

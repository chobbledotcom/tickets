/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  acknowledgePaymentReview,
  openPaymentReview,
} from "#payment/review.ts";
import {
  REVIEW_EVENTS,
  type ReviewMachineEvent,
} from "#payment/review-machine-spec.ts";
import { reviewModelData } from "#scripts/verify-models/review.ts";
import { requireValue } from "#shared/required-value.ts";
import { records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

const acknowledgement = (): ReviewMachineEvent =>
  requireValue(
    REVIEW_EVENTS.find(({ id }) => id === "acknowledge"),
    "The acknowledge event is absent",
  );

const reasons = ["partially_returned_obligation", "shared_reference"] as const;

describe("payment review checker data", () => {
  test("keeps the absent slot and reason-refined open and seen facts", async () => {
    const data = await reviewModelData();

    const nodes = records(data, "ReviewNodes");
    const events = records(data, "ReviewEvents");
    expect(nodes).toContainEqual({
      held: false,
      reason: "",
      seen: false,
      state: "none",
    });
    for (const reason of reasons) {
      expect(nodes).toContainEqual({
        held: true,
        reason,
        seen: false,
        state: `open(${reason})`,
      });
      expect(nodes).toContainEqual({
        held: true,
        reason,
        seen: true,
        state: `seen(${reason})`,
      });
      for (const action of ["open", "retire"]) {
        expect(events).toContainEqual({
          action,
          eventId: `${action}_${reason}`,
          movesMoney: false,
          reason,
        });
      }
    }
    expect(events).toContainEqual({
      action: "acknowledge",
      eventId: "acknowledge",
      movesMoney: false,
      reason: "",
    });
  });

  test("records new cases and refused reopening without losing attempts", async () => {
    const data = await reviewModelData();

    for (const reason of reasons) {
      expect(records(data, "ReviewAttempts")).toContainEqual({
        accepted: true,
        eventId: `open_${reason}`,
        sameCaseId: false,
        sameReason: false,
        sampleTag: "empty",
        sourceState: "none",
        targetState: `open(${reason})`,
      });
      for (const source of ["open", "seen"]) {
        for (const heldReason of reasons) {
          expect(records(data, "ReviewAttempts")).toContainEqual({
            accepted: false,
            eventId: `open_${reason}`,
            sameCaseId: true,
            sameReason: true,
            sampleTag: heldReason,
            sourceState: `${source}(${heldReason})`,
            targetState: `${source}(${heldReason})`,
          });
        }
      }
    }
  });

  test("acknowledgement preserves the actual case and reason and refuses absent or seen cases", async () => {
    const data = await reviewModelData();

    const attempts = records(data, "ReviewAttempts");
    expect(attempts).toContainEqual({
      accepted: false,
      eventId: "acknowledge",
      sameCaseId: true,
      sameReason: true,
      sampleTag: "empty",
      sourceState: "none",
      targetState: "none",
    });
    for (const reason of reasons) {
      expect(attempts).toContainEqual({
        accepted: true,
        eventId: "acknowledge",
        sameCaseId: true,
        sameReason: true,
        sampleTag: reason,
        sourceState: `open(${reason})`,
        targetState: `seen(${reason})`,
      });
      expect(attempts).toContainEqual({
        accepted: false,
        eventId: "acknowledge",
        sameCaseId: true,
        sameReason: true,
        sampleTag: reason,
        sourceState: `seen(${reason})`,
        targetState: `seen(${reason})`,
      });
    }
  });

  test("distinguishes successful no-value retirement from absent and wrong-reason refusals", async () => {
    const data = await reviewModelData();

    for (const reason of reasons) {
      const attempts = records(data, "ReviewAttempts");
      expect(attempts).toContainEqual({
        accepted: false,
        eventId: `retire_${reason}`,
        sameCaseId: true,
        sameReason: true,
        sampleTag: "empty",
        sourceState: "none",
        targetState: "none",
      });
      for (const source of ["open", "seen"]) {
        expect(attempts).toContainEqual({
          accepted: true,
          eventId: `retire_${reason}`,
          sameCaseId: false,
          sameReason: false,
          sampleTag: reason,
          sourceState: `${source}(${reason})`,
          targetState: "none",
        });
        const wrongReason = reasons.find((other) => other !== reason);
        expect(attempts).toContainEqual({
          accepted: false,
          eventId: `retire_${reason}`,
          sameCaseId: true,
          sameReason: true,
          sampleTag: wrongReason,
          sourceState: `${source}(${wrongReason})`,
          targetState: `${source}(${wrongReason})`,
        });
      }
    }
  });

  test("compares case ids rather than assuming every held-to-held result preserves identity", async () => {
    const event = acknowledgement();
    const run = event.run;
    using _run = stub(event, "run", (slot) =>
      slot === undefined ? run(slot) : openPaymentReview(slot.reason),
    );
    const data = await reviewModelData();

    for (const reason of reasons) {
      expect(records(data, "ReviewAttempts")).toContainEqual({
        accepted: true,
        eventId: "acknowledge",
        sameCaseId: false,
        sameReason: true,
        sampleTag: reason,
        sourceState: `open(${reason})`,
        targetState: `open(${reason})`,
      });
    }
  });

  test("compares reasons independently of the case id", async () => {
    const event = acknowledgement();
    const run = event.run;
    using _run = stub(event, "run", (slot) =>
      slot === undefined
        ? run(slot)
        : acknowledgePaymentReview(
            {
              ...slot,
              reason: {
                kind:
                  slot.reason.kind === "shared_reference"
                    ? "partially_returned_obligation"
                    : "shared_reference",
              },
            },
            "2026-08-17T00:00:00.000Z",
          ),
    );
    const data = await reviewModelData();

    expect(records(data, "ReviewAttempts")).toContainEqual({
      accepted: true,
      eventId: "acknowledge",
      sameCaseId: true,
      sameReason: false,
      sampleTag: "shared_reference",
      sourceState: "open(shared_reference)",
      targetState: "seen(partially_returned_obligation)",
    });
    expect(records(data, "ReviewAttempts")).toContainEqual({
      accepted: true,
      eventId: "acknowledge",
      sameCaseId: true,
      sameReason: false,
      sampleTag: "partially_returned_obligation",
      sourceState: "open(partially_returned_obligation)",
      targetState: "seen(shared_reference)",
    });
  });

  test("carries declared money metadata for every action instead of supplying a constant", async () => {
    const original = REVIEW_EVENTS.map((event) => event.movesMoney);
    try {
      for (const event of REVIEW_EVENTS) {
        Object.defineProperty(event, "movesMoney", { value: true });
      }
      const data = await reviewModelData();
      const events = records(data, "ReviewEvents");
      expect(events).toContainEqual({
        action: "acknowledge",
        eventId: "acknowledge",
        movesMoney: true,
        reason: "",
      });
      for (const reason of reasons) {
        for (const action of ["open", "retire"]) {
          expect(events).toContainEqual({
            action,
            eventId: `${action}_${reason}`,
            movesMoney: true,
            reason,
          });
        }
      }
    } finally {
      for (const [index, event] of REVIEW_EVENTS.entries()) {
        Object.defineProperty(event, "movesMoney", { value: original[index] });
      }
    }
  });

  test("rejects an event whose operation the checker cannot classify", async () => {
    const event = acknowledgement();
    const id = event.id;
    try {
      Object.defineProperty(event, "id", { value: "resolve_shared_reference" });
      await expect(reviewModelData()).rejects.toThrow(
        "Unknown review operation resolve_shared_reference",
      );
    } finally {
      Object.defineProperty(event, "id", { value: id });
    }
  });
});

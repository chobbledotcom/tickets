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

    expect(data).toContain('<<"none", FALSE, FALSE, "">>');
    for (const reason of reasons) {
      expect(data).toContain(`<<"open(${reason})", TRUE, FALSE, "${reason}">>`);
      expect(data).toContain(`<<"seen(${reason})", TRUE, TRUE, "${reason}">>`);
      expect(data).toContain(
        `<<"open_${reason}", "open", "${reason}", FALSE>>`,
      );
      expect(data).toContain(
        `<<"retire_${reason}", "retire", "${reason}", FALSE>>`,
      );
    }
    expect(data).toContain('<<"acknowledge", "acknowledge", "", FALSE>>');
  });

  test("records new cases and refused reopening without losing attempts", async () => {
    const data = await reviewModelData();

    for (const reason of reasons) {
      expect(data).toContain(
        `<<"none", "open_${reason}", "open(${reason})", "empty", TRUE, FALSE, FALSE>>`,
      );
      for (const source of ["open", "seen"]) {
        for (const heldReason of reasons) {
          expect(data).toContain(
            `<<"${source}(${heldReason})", "open_${reason}", "${source}(${heldReason})", "${heldReason}", FALSE, TRUE, TRUE>>`,
          );
        }
      }
    }
  });

  test("acknowledgement preserves the actual case and reason and refuses absent or seen cases", async () => {
    const data = await reviewModelData();

    expect(data).toContain(
      '<<"none", "acknowledge", "none", "empty", FALSE, TRUE, TRUE>>',
    );
    for (const reason of reasons) {
      expect(data).toContain(
        `<<"open(${reason})", "acknowledge", "seen(${reason})", "${reason}", TRUE, TRUE, TRUE>>`,
      );
      expect(data).toContain(
        `<<"seen(${reason})", "acknowledge", "seen(${reason})", "${reason}", FALSE, TRUE, TRUE>>`,
      );
    }
  });

  test("distinguishes successful no-value retirement from absent and wrong-reason refusals", async () => {
    const data = await reviewModelData();

    for (const reason of reasons) {
      expect(data).toContain(
        `<<"none", "retire_${reason}", "none", "empty", FALSE, TRUE, TRUE>>`,
      );
      for (const source of ["open", "seen"]) {
        expect(data).toContain(
          `<<"${source}(${reason})", "retire_${reason}", "none", "${reason}", TRUE, FALSE, FALSE>>`,
        );
        const wrongReason = reasons.find((other) => other !== reason);
        expect(data).toContain(
          `<<"${source}(${wrongReason})", "retire_${reason}", "${source}(${wrongReason})", "${wrongReason}", FALSE, TRUE, TRUE>>`,
        );
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
      expect(data).toContain(
        `<<"open(${reason})", "acknowledge", "open(${reason})", "${reason}", TRUE, FALSE, TRUE>>`,
      );
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

    expect(data).toContain(
      '<<"open(shared_reference)", "acknowledge", "seen(partially_returned_obligation)", "shared_reference", TRUE, TRUE, FALSE>>',
    );
    expect(data).toContain(
      '<<"open(partially_returned_obligation)", "acknowledge", "seen(shared_reference)", "partially_returned_obligation", TRUE, TRUE, FALSE>>',
    );
  });

  test("carries declared money metadata for every action instead of supplying a constant", async () => {
    const original = REVIEW_EVENTS.map((event) => event.movesMoney);
    try {
      for (const event of REVIEW_EVENTS) {
        Object.defineProperty(event, "movesMoney", { value: true });
      }
      const data = await reviewModelData();
      expect(data).toContain('<<"acknowledge", "acknowledge", "", TRUE>>');
      for (const reason of reasons) {
        expect(data).toContain(
          `<<"open_${reason}", "open", "${reason}", TRUE>>`,
        );
        expect(data).toContain(
          `<<"retire_${reason}", "retire", "${reason}", TRUE>>`,
        );
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

/** Executes the whole payment-review table through the shared machine-spec
 * executors, then proves the review-specific halves: the reason list
 * matches the retirement rule, every reason both opens and retires, no
 * review event moves money, and every exported review function drives the
 * spec. */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PAYMENT_REVIEW_RETIREMENT } from "#shared/payment/review.ts";
import {
  EXPECTED_MOVES,
  REVIEW_EVENTS,
  REVIEW_NODES,
  REVIEW_REASONS,
  reviewNodeOf,
} from "#shared/payment/review-machine-spec.ts";
import {
  registerConformanceSweep,
  registerTableChecks,
} from "#test/test-utils/machine-spec.ts";

const REVIEW_SPEC = {
  events: REVIEW_EVENTS,
  moves: EXPECTED_MOVES,
  nodeOf: reviewNodeOf,
  nodes: REVIEW_NODES,
};

const paymentSourceDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/shared/payment",
);

describe("the payment review table", () => {
  describe("cell conformance — every event against every stored shape", () => {
    registerConformanceSweep(REVIEW_SPEC);
  });

  describe("table shape", () => {
    registerTableChecks(REVIEW_SPEC, { events: 5, nodes: 3, shapes: 5 });
  });

  test("the reason list is exactly the retirement rule's own keys", () => {
    expect([...REVIEW_REASONS].sort()).toEqual(
      Object.keys(PAYMENT_REVIEW_RETIREMENT).sort(),
    );
  });

  test("every reason both opens and retires, labelled by its own rule", () => {
    const byId = new Map(REVIEW_EVENTS.map((event) => [event.id, event]));
    expect(byId.get("acknowledge")?.labelKey).toBe(
      "schema.review.edge.acknowledge",
    );
    for (const kind of REVIEW_REASONS) {
      const opens = byId.get(`open_${kind}`);
      const retires = byId.get(`retire_${kind}`);
      expect(opens?.labelKey, kind).toBe(`schema.review.reason.${kind}`);
      expect(retires?.labelKey, kind).toBe(
        `schema.review.evidence.${PAYMENT_REVIEW_RETIREMENT[kind]}`,
      );
    }
  });

  test("no review event moves money", () => {
    expect(REVIEW_EVENTS.filter(({ movesMoney }) => movesMoney)).toEqual([]);
  });

  test("every exported review function drives the machine spec", async () => {
    // Exports that are not transitions, each named with what covers it.
    const NOT_TRANSITIONS: Readonly<Record<string, string>> = {
      PaymentReviewCaseSchema:
        "the stored shape — validated where cases are read and written",
      PaymentReviewReasonSchema:
        "the reason shape — validated where cases are read and written",
    };
    const spec = await Deno.readTextFile(
      join(paymentSourceDir, "review-machine-spec.ts"),
    );
    const source = await Deno.readTextFile(join(paymentSourceDir, "review.ts"));
    const names = [...source.matchAll(/^export const (\w+)/gm)].map(
      (match) => match[1]!,
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      if (name in NOT_TRANSITIONS) continue;
      expect(
        spec.includes(name),
        `review.ts exports ${name} but the machine spec never drives it`,
      ).toBe(true);
    }
  });
});

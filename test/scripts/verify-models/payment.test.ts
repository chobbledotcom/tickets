/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type {
  RefundAuthorityState,
  RefundRequestGeneration,
} from "#payment/refund-authority-state.ts";
import { REFUND_EVENTS } from "#payment/refund-machine-spec.ts";
import { ROW_NODES } from "#payment/row-machine-spec.ts";
import { modelData, paymentModel } from "#scripts/verify-models/model.ts";
import { requireValue } from "#shared/required-value.ts";
import { records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

type ArmChange = (
  before: RefundAuthorityState,
  after: RefundAuthorityState,
) => RefundAuthorityState;
type RequestChange = (
  request: RefundRequestGeneration,
) => RefundRequestGeneration;

const changeArm = (change: ArmChange) => {
  const event = requireValue(
    REFUND_EVENTS.find(({ id }) => id === "arm"),
    "The arm event is absent",
  );
  const run = event.run;
  return stub(event, "run", (state) => change(state, run(state)));
};

const changedRequests: readonly (readonly [string, RequestChange])[] = [
  [
    "generation",
    (request) => ({ ...request, generation: request.generation + 1 }),
  ],
  [
    "identity",
    (request) => ({
      ...request,
      identityIndex: `${request.identityIndex}-changed`,
    }),
  ],
  [
    "capability",
    (request) => ({
      capability: "keyless",
      generation: request.generation,
      identityIndex: request.identityIndex,
    }),
  ],
  [
    "replay deadline",
    (request) =>
      request.capability === "keyed"
        ? { ...request, replayUntil: request.replayUntil + 1 }
        : request,
  ],
];

describe("payment proof data", () => {
  test("rejects a node that mixes claimed and unclaimed representatives", async () => {
    const node = requireValue(
      ROW_NODES.find(({ id }) => id === "claim"),
      "The claim node is absent",
    );
    const reps = node.reps;
    Object.assign(node, { reps: [...reps, { state: {}, tag: "unheld" }] });
    try {
      await expect(paymentModel()).rejects.toThrow(
        "Row node claim mixes claimed and unclaimed states",
      );
    } finally {
      Object.assign(node, { reps });
    }
  });

  test("emits an unsafe send as a false fact instead of dropping its edge", async () => {
    using _arm = changeArm((before) => before);
    const model = await paymentModel();
    const unsafeMove = {
      armed: false,
      eventId: "arm",
      requestKept: true,
      sourceState: "ready",
      targetState: "ready",
    };
    expect(records(modelData(model), "AuthMoves")).toContainEqual(unsafeMove);
  });

  for (const [field, change] of changedRequests) {
    test(`emits a changed refund request ${field} as a false fact`, async () => {
      using _arm = changeArm((_before, after) => ({
        ...after,
        request: change(after.request),
      }));
      const model = await paymentModel();
      const unsafeMove = {
        armed: true,
        eventId: "arm",
        requestKept: false,
        sourceState: "ready",
        targetState: "send_armed",
      };
      expect(records(modelData(model), "AuthMoves")).toContainEqual(unsafeMove);
    });
  }
});

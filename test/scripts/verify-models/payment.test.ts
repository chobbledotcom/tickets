/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type {
  RefundAuthorityState,
  RefundRequestGeneration,
} from "#payment/refund-authority-state.ts";
import { REFUND_EVENTS, REFUND_NODES } from "#payment/refund-machine-spec.ts";
import { ROW_NODES } from "#payment/row-machine-spec.ts";
import { modelData, paymentModel } from "#scripts/verify-models/model.ts";
import { requireValue } from "#shared/required-value.ts";
import { members, records } from "#test-utils/tla-data.ts";

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

const replayEvent = requireValue(
  REFUND_EVENTS.find(({ id }) => id === "replay"),
  "The replay event is absent",
);

const changeReplay = (change: ArmChange) => {
  const run = replayEvent.run;
  return stub(replayEvent, "run", (state) => change(state, run(state)));
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
      inWindow: true,
      keyed: true,
      replay: false,
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
        inWindow: true,
        keyed: true,
        replay: false,
        requestKept: false,
        sourceState: "ready",
        targetState: "send_armed",
      };
      expect(records(modelData(model), "AuthMoves")).toContainEqual(unsafeMove);
    });

    test(`emits a replayed refund request ${field} as a false fact`, async () => {
      using _replay = changeReplay((_before, after) => ({
        ...after,
        request: change(after.request),
      }));
      const model = await paymentModel();
      const unsafeMove = {
        armed: true,
        eventId: "replay",
        inWindow: true,
        keyed: true,
        replay: true,
        requestKept: false,
        sourceState: "send_armed",
        targetState: "send_armed",
      };
      expect(records(modelData(model), "AuthMoves")).toContainEqual(unsafeMove);
    });
  }

  test("emits an accepted keyless replay as a false fact", async () => {
    using _replay = stub(replayEvent, "run", (state) => state);
    const model = await paymentModel();
    expect(records(modelData(model), "AuthMoves")).toContainEqual({
      armed: true,
      eventId: "replay",
      inWindow: true,
      keyed: false,
      replay: true,
      requestKept: true,
      sourceState: "send_armed",
      targetState: "send_armed",
    });
  });

  test("emits a replay outside the provider window as a false fact", async () => {
    const run = replayEvent.run;
    using _replay = stub(replayEvent, "run", (state) => {
      const armed = run(state);
      const replayUntil =
        state.request.capability === "keyed" ? state.request.replayUntil : 0;
      return { ...armed, armedAt: replayUntil + 1 };
    });
    const model = await paymentModel();
    expect(records(modelData(model), "AuthMoves")).toContainEqual({
      armed: true,
      eventId: "replay",
      inWindow: false,
      keyed: true,
      replay: true,
      requestKept: true,
      sourceState: "send_armed",
      targetState: "send_armed",
    });
  });

  test("not-sent evidence and owner decisions never re-arm a send", async () => {
    const data = modelData(await paymentModel());
    const distinct = records(data, "AuthMoves").filter((move) =>
      [
        "proved_not_sent",
        "owner_confirms_not_sent",
        "owner_confirms_returned",
      ].includes(move.eventId as string),
    );
    expect(distinct.length).toBeGreaterThan(0);
    for (const move of distinct) {
      expect(move.replay).toBe(false);
      expect(move.targetState).not.toBe("send_armed");
    }
  });

  test("only completed-and-recorded refunds are eligible for deletion", async () => {
    const data = modelData(await paymentModel());
    expect(members(data, "PrunableStates").sort()).toEqual([
      "absent",
      "recorded",
    ]);
  });

  test("rejects a node that mixes prunable and unprunable representatives", async () => {
    const node = requireValue(
      REFUND_NODES.find(({ id }) => id === "recorded"),
      "The recorded node is absent",
    );
    const returned = requireValue(
      REFUND_NODES.find(({ id }) => id === "returned"),
      "The returned node is absent",
    );
    const returnedState = requireValue(
      returned.reps[0],
      "The returned node carries no representative",
    ).state;
    const reps = node.reps;
    Object.assign(node, {
      reps: [...reps, { state: returnedState, tag: "unrecorded" }],
    });
    try {
      await expect(paymentModel()).rejects.toThrow(
        "Refund node recorded mixes prunable and unprunable states",
      );
    } finally {
      Object.assign(node, { reps });
    }
  });
});

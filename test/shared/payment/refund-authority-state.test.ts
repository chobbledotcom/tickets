import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  markRefundCompleted,
  markRefundLocalRecorded,
} from "#shared/payment/refund-authority.ts";
import {
  markRefundOwnerChoiceNeeded,
  markRefundProviderConflict,
} from "#shared/payment/refund-authority-choice.ts";
import {
  readRefundAuthorityState,
  refundLocalMirror,
  refundNextActionAt,
  refundStateMirror,
  validateRefundAuthorityState,
  writeRefundAuthorityState,
} from "#shared/payment/refund-authority-state.ts";
import {
  keyedObservingRefundForTest,
  keylessArmedRefundForTest,
  readyRefundForTest,
} from "#test-utils/refund-authority.ts";

describe("payment > stored refund authority state", () => {
  test("zero is a valid recorded time", () => {
    const state = readyRefundForTest("keyed", {
      nextActionAt: 0,
      now: 0,
      replayUntil: 0,
    });

    expect(state).toMatchObject({ nextActionAt: 0, readyAt: 0 });
  });

  test("every keyed and keyless request generation starts at one", () => {
    const keyed = readyRefundForTest("keyed");
    const keyless = readyRefundForTest("keyless");

    expect(() =>
      writeRefundAuthorityState({
        ...keyed,
        request: { ...keyed.request, generation: 0 },
      }),
    ).toThrow();
    expect(() =>
      writeRefundAuthorityState({
        ...keyless,
        request: { ...keyless.request, generation: 0 },
      }),
    ).toThrow();
  });

  test("active evidence revisions start at one", () => {
    const state = readyRefundForTest("keyless");
    const completed = markRefundCompleted(state, 140, "provider");

    expect(() =>
      writeRefundAuthorityState({ ...state, evidenceRevision: 0 }),
    ).toThrow();
    expect(() =>
      writeRefundAuthorityState({ ...completed, evidenceRevision: 0 }),
    ).toThrow();
  });

  test("attention evidence revisions start at one", () => {
    const state = markRefundOwnerChoiceNeeded(
      keylessArmedRefundForTest(),
      180,
      "possibly_sent",
    );

    expect(() =>
      validateRefundAuthorityState({ ...state, evidenceRevision: 0 }),
    ).toThrow();
  });

  test("every stored owner reason is admitted by its real request state", () => {
    const states = [
      markRefundOwnerChoiceNeeded(
        keylessArmedRefundForTest(),
        180,
        "possibly_sent",
      ),
      markRefundOwnerChoiceNeeded(
        keylessArmedRefundForTest(),
        180,
        "provider_rejected",
      ),
      markRefundOwnerChoiceNeeded(
        readyRefundForTest("keyed"),
        180,
        "provider_unreadable",
      ),
      markRefundOwnerChoiceNeeded(
        keyedObservingRefundForTest(),
        510,
        "replay_window_expired",
      ),
      markRefundProviderConflict(keylessArmedRefundForTest(), 180, {
        captured: { amount: 2_000, currency: "GBP" },
        kind: "not_sent",
        refunded: { amount: 0, currency: "GBP" },
      }),
    ];

    expect(states.map((state) => state.reason)).toEqual([
      "possibly_sent",
      "provider_rejected",
      "provider_unreadable",
      "replay_window_expired",
      "provider_conflict",
    ]);
    expect(
      states.map(
        (state) =>
          readRefundAuthorityState(writeRefundAuthorityState(state), "state")
            .kind,
      ),
    ).toEqual([
      "needs_owner_choice",
      "needs_owner_choice",
      "needs_owner_choice",
      "needs_owner_choice",
      "needs_owner_choice",
    ]);
  });

  test("owner reasons reject a request that cannot support them", () => {
    const expired = markRefundOwnerChoiceNeeded(
      keyedObservingRefundForTest(),
      510,
      "replay_window_expired",
    );

    expect(() =>
      validateRefundAuthorityState({ ...expired, openedAt: 500 }),
    ).toThrow("Owner choice reason does not match the refund request");
  });

  test("provider conflicts store only under their matching attention state", () => {
    const ownerChoice = markRefundProviderConflict(
      keylessArmedRefundForTest(),
      180,
      {
        captured: { amount: 2_000, currency: "GBP" },
        kind: "not_sent",
        refunded: { amount: 0, currency: "GBP" },
      },
    );
    const providerCheck = markRefundProviderConflict(
      keylessArmedRefundForTest(),
      180,
      {
        captured: { amount: 2_000, currency: "GBP" },
        kind: "returned",
        refunded: { amount: 500, currency: "GBP" },
      },
    );

    expect(validateRefundAuthorityState(ownerChoice).kind).toBe(
      "needs_owner_choice",
    );
    expect(validateRefundAuthorityState(providerCheck).kind).toBe(
      "needs_provider_check",
    );
    expect(() =>
      validateRefundAuthorityState({
        ...providerCheck,
        kind: "needs_owner_choice",
      }),
    ).toThrow("An owner-choice conflict must admit an owner decision");
    expect(() =>
      validateRefundAuthorityState({
        ...ownerChoice,
        kind: "needs_provider_check",
      }),
    ).toThrow(
      "A provider-check state must carry evidence that cannot be decided yet",
    );
  });

  test("completed money stores exact proof and an immediately due local write", () => {
    const ownerCompleted = markRefundCompleted(
      readyRefundForTest("keyless"),
      140,
      "owner",
    );

    expect(validateRefundAuthorityState(ownerCompleted)).toMatchObject({
      kind: "completed",
      proof: "owner",
    });
    expect(() =>
      validateRefundAuthorityState({
        ...ownerCompleted,
        nextActionAt: 141,
      }),
    ).toThrow("Returned money must make its local recording due now");
  });

  test("stores one strict tagged state", () => {
    const state = readyRefundForTest("keyed");
    const stored = writeRefundAuthorityState(state, "test charge");

    expect(readRefundAuthorityState(stored, "test charge")).toEqual(state);
    expect(() =>
      readRefundAuthorityState(
        JSON.stringify({ ...state, surprise: true }),
        "test charge",
      ),
    ).toThrow("Invalid stored JSON");
  });

  test("plain mirrors are always derived from the parsed state", () => {
    const ready = readyRefundForTest("keyed");
    const completed = markRefundCompleted(ready, 140, "provider");

    expect(refundStateMirror(ready)).toBe("ready");
    expect(refundLocalMirror(completed)).toBe("due");
    expect(refundNextActionAt(ready)).toBe(110);
    expect(refundNextActionAt(completed)).toBe(140);
    expect(
      refundNextActionAt(markRefundLocalRecorded(completed, 160)),
    ).toBeNull();
  });
});

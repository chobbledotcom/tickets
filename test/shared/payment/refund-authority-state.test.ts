import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  readRefundAuthorityState,
  refundLocalMirror,
  refundNextActionAt,
  refundStateMirror,
  writeRefundAuthorityState,
} from "#shared/payment/refund-authority-state.ts";
import {
  markRefundCompleted,
  markRefundLocalRecorded,
} from "#shared/payment/refund-authority.ts";
import { readyRefundForTest } from "#test-utils/refund-authority.ts";

describe("payment > stored refund authority state", () => {
  test("stores one strict tagged state", () => {
    const state = readyRefundForTest("keyed");
    const stored = writeRefundAuthorityState(state, "test charge");

    expect(readRefundAuthorityState(stored, "test charge")).toEqual(state);
    expect(() =>
      readRefundAuthorityState(
        JSON.stringify({ ...state, surprise: true }),
        "test charge",
      )
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

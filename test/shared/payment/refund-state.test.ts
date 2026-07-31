import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { refundStateOf } from "#shared/payment/refund-state.ts";

describe("refund state", () => {
  describe("refundStateOf", () => {
    it("marks a refunded charge completed either way", () => {
      expect(refundStateOf({ legacy: false, refunded: true })).toBe(
        "completed",
      );
      expect(refundStateOf({ legacy: true, refunded: true })).toBe("completed");
    });

    it("marks a current, not-refunded charge none", () => {
      expect(refundStateOf({ legacy: false, refunded: false })).toBe("none");
    });

    // The rule the live path must keep: "unknown" is the state of a legacy
    // charge whose refund was never observed, and only a legacy charge may
    // carry it. A current charge is always a known "none" or "completed".
    it("marks a legacy, not-refunded charge unknown", () => {
      expect(refundStateOf({ legacy: true, refunded: false })).toBe("unknown");
    });

    it("never reports unknown for a current charge", () => {
      for (const refunded of [false, true]) {
        expect(refundStateOf({ legacy: false, refunded })).not.toBe("unknown");
      }
    });
  });
});

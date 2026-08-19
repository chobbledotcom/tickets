import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { refundStateOf } from "#payment/refund-state.ts";

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

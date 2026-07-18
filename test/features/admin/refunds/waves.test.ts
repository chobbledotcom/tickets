import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  combineRefundOutcomes,
  packByReferenceCount,
} from "#routes/admin/refunds/waves.ts";
import { refs, threeCandidates } from "./helpers.ts";

describe("packByReferenceCount", () => {
  test("packs candidates into waves that stay within the budget", () => {
    const [a, b, c] = threeCandidates(2, 1, 2);

    expect(packByReferenceCount(3)([a, b, c])).toEqual([[a, b], [c]]);
  });

  test("adds the running count to the incoming size rather than multiplying it", () => {
    const a = refs("a", 1);
    const b = refs("b", 3);

    expect(packByReferenceCount(3)([a, b])).toEqual([[a], [b]]);
  });

  test("resets the running count when a new wave starts", () => {
    const [a, b, c] = threeCandidates(2, 2, 1);

    expect(packByReferenceCount(3)([a, b, c])).toEqual([[a], [b, c]]);
  });

  test("increases the running count when appending to a wave", () => {
    const [a, b, c] = threeCandidates(1, 1, 2);

    expect(packByReferenceCount(3)([a, b, c])).toEqual([[a, b], [c]]);
  });

  test("keeps candidates together while the count stays at the budget", () => {
    const [a, b, c] = threeCandidates(1, 1, 1);

    expect(packByReferenceCount(3)([a, b, c])).toEqual([[a, b, c]]);
  });

  test("gives an over-budget candidate its own wave", () => {
    const big = refs("x", 3);
    const small = refs("y", 1);

    expect(packByReferenceCount(2)([big, small])).toEqual([[big], [small]]);
  });

  test("returns no waves for an empty candidate list", () => {
    expect(packByReferenceCount(3)([])).toEqual([]);
  });
});

describe("combineRefundOutcomes", () => {
  test("prefers errored over every other outcome", () => {
    expect(combineRefundOutcomes(["refunded", "failed", "errored"])).toBe(
      "errored",
    );
  });

  test("prefers failed over refunded when nothing errored", () => {
    expect(combineRefundOutcomes(["refunded", "failed"])).toBe("failed");
  });

  test("keeps a pending reference pending when none failed", () => {
    expect(combineRefundOutcomes(["refunded", "pending"])).toBe("pending");
  });

  test("is refunded only when every outcome is refunded", () => {
    expect(combineRefundOutcomes(["refunded", "refunded"])).toBe("refunded");
  });

  test("is refunded for an empty outcome list", () => {
    expect(combineRefundOutcomes([])).toBe("refunded");
  });
});

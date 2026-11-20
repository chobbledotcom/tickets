import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { checkedDurationDays } from "#routes/admin/listings-form.ts";

describe("checkedDurationDays", () => {
  test("returns the duration, and refuses a missing one", () => {
    expect(checkedDurationDays({ durationDays: 3 })).toBe(3);
    expect(() => checkedDurationDays({ durationDays: null })).toThrow(
      "The booking duration form box holds no count",
    );
  });
});

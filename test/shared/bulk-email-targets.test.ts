import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isBulkEmailTarget } from "#shared/bulk-email-targets.ts";

describe("bulk email targets", () => {
  test("accepts every target kind", () => {
    expect(isBulkEmailTarget({ audience: "active", kind: "audience" })).toBe(
      true,
    );
    expect(isBulkEmailTarget({ kind: "listing", listingId: 3 })).toBe(true);
    expect(isBulkEmailTarget({ kind: "attendee", token: "tok123" })).toBe(true);
  });

  test("rejects incomplete and invalid targets", () => {
    for (const target of [
      { audience: "bogus", kind: "audience" },
      { kind: "audience" },
      { kind: "listing", listingId: 1.5 },
      { kind: "listing" },
      { kind: "attendee", token: "" },
      { kind: "attendee" },
      { kind: "other" },
      { kind: 123 },
      {},
      null,
      "nope",
    ]) {
      expect(isBulkEmailTarget(target)).toBe(false);
    }
  });
});

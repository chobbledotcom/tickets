import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { isBulkEmailTarget } from "#shared/bulk-email-targets/types.ts";

describe("bulk email targets", () => {
  test("accepts every target kind", () => {
    expect(isBulkEmailTarget({ audience: "active", kind: "audience" })).toBe(
      true,
    );
    expect(isBulkEmailTarget({ kind: "listing", listingId: 3 })).toBe(true);
    expect(
      isBulkEmailTarget({
        day: "2026-03-02",
        kind: "listing-day",
        listingId: 3,
      }),
    ).toBe(true);
    expect(isBulkEmailTarget({ kind: "attendee", token: "tok123" })).toBe(true);
  });

  test("rejects incomplete and invalid targets", () => {
    for (const target of [
      { audience: "bogus", kind: "audience" },
      { kind: "audience" },
      { kind: "listing", listingId: 1.5 },
      { kind: "listing" },
      { day: "2026-02-30", kind: "listing-day", listingId: 3 },
      { day: "2026-3-2", kind: "listing-day", listingId: 3 },
      { day: "", kind: "listing-day", listingId: 3 },
      { kind: "listing-day", listingId: 3 },
      { day: "2026-03-02", kind: "listing-day" },
      { day: "2026-03-02", kind: "listing-day", listingId: 1.5 },
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

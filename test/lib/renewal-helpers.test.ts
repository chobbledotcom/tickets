import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatDeadlineLabel, isProvisioned } from "#shared/renewal-helpers.ts";
import { testBuiltSite } from "#test-utils";

describe("isProvisioned", () => {
  test("returns true when both renewalTokenIndex and renewalTierEventId are set", () => {
    const site = testBuiltSite({
      renewalTokenIndex: "abc123",
      renewalTierEventId: 5,
    });
    expect(isProvisioned(site)).toBe(true);
  });

  test("returns false when renewalTokenIndex is null", () => {
    const site = testBuiltSite({
      renewalTokenIndex: null,
      renewalTierEventId: 5,
    });
    expect(isProvisioned(site)).toBe(false);
  });

  test("returns false when renewalTierEventId is null", () => {
    const site = testBuiltSite({
      renewalTokenIndex: "abc123",
      renewalTierEventId: null,
    });
    expect(isProvisioned(site)).toBe(false);
  });

  test("returns false when both are null", () => {
    const site = testBuiltSite({
      renewalTokenIndex: null,
      renewalTierEventId: null,
    });
    expect(isProvisioned(site)).toBe(false);
  });
});

describe("formatDeadlineLabel", () => {
  const DAY_MS = 86_400_000;
  const NOW = Date.parse("2026-05-17T12:00:00.000Z");

  test("returns 'never' for empty string", () => {
    expect(formatDeadlineLabel("", NOW)).toBe("never");
  });

  test("returns 'never' for invalid date", () => {
    expect(formatDeadlineLabel("not-a-date", NOW)).toBe("never");
  });

  test("returns 'today' for same-day cutoff", () => {
    expect(formatDeadlineLabel("2026-05-17T18:00:00.000Z", NOW)).toBe(
      "today",
    );
  });

  test("returns exact future day count", () => {
    const future = new Date(NOW + 7 * DAY_MS).toISOString();
    expect(formatDeadlineLabel(future, NOW)).toBe("in 7 day(s)");
  });

  test("returns exact past day count", () => {
    const past = new Date(NOW - 3 * DAY_MS).toISOString();
    expect(formatDeadlineLabel(past, NOW)).toBe("expired 3 day(s) ago");
  });
});

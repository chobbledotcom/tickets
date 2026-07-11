import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatDeadlineLabel, isProvisioned } from "#shared/renewal-helpers.ts";
import { testBuiltSite } from "#test-utils/factories.ts";

describe("isProvisioned", () => {
  test("returns true when renewalTokenIndex is set", () => {
    const site = testBuiltSite({ renewalTokenIndex: "abc123" });
    expect(isProvisioned(site)).toBe(true);
  });

  test("returns false when renewalTokenIndex is null", () => {
    const site = testBuiltSite({ renewalTokenIndex: null });
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
    expect(formatDeadlineLabel("2026-05-17T18:00:00.000Z", NOW)).toBe("today");
  });

  test("returns exact future day count", () => {
    const future = new Date(NOW + 7 * DAY_MS).toISOString();
    expect(formatDeadlineLabel(future, NOW)).toBe("in 7 day(s)");
  });

  test("returns exact past day count", () => {
    const past = new Date(NOW - 3 * DAY_MS).toISOString();
    expect(formatDeadlineLabel(past, NOW)).toBe("expired 3 day(s) ago");
  });

  test("rounds a hair under the 1.5-day mark down to 1 day, not 2", () => {
    const future = new Date(NOW + 1.5 * DAY_MS - 1).toISOString();
    expect(formatDeadlineLabel(future, NOW)).toBe("in 1 day(s)");
  });

  test("rounds a hair over the 1.5-day mark up to 2 days, not 1", () => {
    const future = new Date(NOW + 1.5 * DAY_MS + 1).toISOString();
    expect(formatDeadlineLabel(future, NOW)).toBe("in 2 day(s)");
  });
});

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  formatBuildDate,
  isNewerVersion,
  setBuildTimestampForTest,
} from "#lib/update.ts";

describe("update", () => {
  afterEach(() => {
    setBuildTimestampForTest(null);
  });

  describe("isNewerVersion", () => {
    test("returns false in development (no build timestamp)", () => {
      expect(isNewerVersion("v2099-01-01-000000")).toBe(false);
    });

    test("returns false for unparseable tags", () => {
      setBuildTimestampForTest("2026-01-01T00:00:00Z");
      expect(isNewerVersion("invalid")).toBe(false);
      expect(isNewerVersion("1.0.0")).toBe(false);
      expect(isNewerVersion("v2026-03-28")).toBe(false);
    });

    test("returns true when release tag is newer than build", () => {
      setBuildTimestampForTest("2026-01-01T00:00:00Z");
      expect(isNewerVersion("v2026-06-15-120000")).toBe(true);
    });

    test("returns false when release tag is older than build", () => {
      setBuildTimestampForTest("2026-06-15T12:00:00Z");
      expect(isNewerVersion("v2026-01-01-000000")).toBe(false);
    });

    test("returns false when release tag equals build timestamp", () => {
      setBuildTimestampForTest("2026-03-28T14:30:22Z");
      expect(isNewerVersion("v2026-03-28-143022")).toBe(false);
    });

    test("handles build date newer than latest release", () => {
      // Simulates a deploy-to-clients build that's newer than the latest release
      setBuildTimestampForTest("2026-04-01T10:00:00Z");
      expect(isNewerVersion("v2026-03-28-143022")).toBe(false);
    });
  });

  describe("formatBuildDate", () => {
    test("formats an ISO timestamp for display", () => {
      const result = formatBuildDate("2026-03-28T14:30:22.000Z");
      expect(result).toContain("2026");
      expect(result).toContain("UTC");
    });

    test("returns Development build for empty string", () => {
      expect(formatBuildDate("")).toBe("Development build");
    });
  });
});

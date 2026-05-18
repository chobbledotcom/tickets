import process from "node:process";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import {
  getEnv,
  getReadOnlyCutoffIso,
  getRenewalUrl,
  isInWarningWindow,
  isReadOnly,
  isReadOnlyFromCutoff,
  isReadOnlyWarning,
  parseWarnDays,
  requireEnv,
} from "#shared/env.ts";
import { describeWithEnv } from "#test-utils";

const KEY = "TEST_ENV_VAR_FOR_ENV_SPEC";

const DAY_MS = 86_400_000;

const isoFromNow = (offsetMs: number): string =>
  new Date(Date.now() + offsetMs).toISOString();

describeWithEnv(
  "env",
  {
    env: {
      [KEY]: undefined,
      READ_ONLY_FROM: undefined,
      READ_ONLY_WARN_DAYS: undefined,
      RENEWAL_URL: undefined,
    },
  },
  () => {
    describe("getEnv", () => {
      test("returns the value set in the environment", () => {
        process.env[KEY] = "hello";
        expect(getEnv(KEY)).toBe("hello");
      });

      test("returns undefined when the variable is not set", () => {
        expect(getEnv(KEY)).toBeUndefined();
      });

      test("returns an empty string when the variable is set to empty", () => {
        process.env[KEY] = "";
        expect(getEnv(KEY)).toBe("");
      });
    });

    describe("requireEnv", () => {
      test("returns the value when the variable is set", () => {
        process.env[KEY] = "required_value";
        expect(requireEnv(KEY)).toBe("required_value");
      });

      test("throws an error that names the missing key", () => {
        expect(() => requireEnv(KEY)).toThrow(KEY);
      });
    });

    describe("isReadOnly", () => {
      test("is false when READ_ONLY_FROM is unset", () => {
        expect(isReadOnly()).toBe(false);
      });

      test("is true when READ_ONLY_FROM is in the past", () => {
        process.env.READ_ONLY_FROM = isoFromNow(-DAY_MS);
        expect(isReadOnly()).toBe(true);
      });

      test("is false when READ_ONLY_FROM is in the future", () => {
        process.env.READ_ONLY_FROM = isoFromNow(DAY_MS * 30);
        expect(isReadOnly()).toBe(false);
      });

      test("is false when READ_ONLY_FROM is malformed (fail open)", async () => {
        process.env.READ_ONLY_FROM = "not-a-date";
        const errorSpy = spy(console, "error");
        try {
          expect(isReadOnly()).toBe(false);
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(errorSpy.calls.length).toBe(1);
        } finally {
          errorSpy.restore();
        }
      });
    });

    describe("isReadOnlyWarning", () => {
      test("is true when inside warning window", () => {
        process.env.READ_ONLY_FROM = isoFromNow(DAY_MS * 7);
        process.env.READ_ONLY_WARN_DAYS = "14";
        expect(isReadOnlyWarning()).toBe(true);
      });

      test("is false when outside warning window", () => {
        process.env.READ_ONLY_FROM = isoFromNow(DAY_MS * 30);
        process.env.READ_ONLY_WARN_DAYS = "14";
        expect(isReadOnlyWarning()).toBe(false);
      });

      test("is false when already read-only", () => {
        process.env.READ_ONLY_FROM = isoFromNow(-DAY_MS);
        expect(isReadOnlyWarning()).toBe(false);
      });

      test("is false when READ_ONLY_FROM is unset", () => {
        delete process.env.READ_ONLY_FROM;
        expect(isReadOnlyWarning()).toBe(false);
      });

      test("is false when READ_ONLY_FROM is in the past", () => {
        process.env.READ_ONLY_FROM = isoFromNow(-DAY_MS);
        expect(isReadOnlyWarning()).toBe(false);
      });
    });

    describe("getReadOnlyCutoffIso", () => {
      test("returns the ISO string when READ_ONLY_FROM is set", () => {
        const cutoff = isoFromNow(DAY_MS * 10);
        process.env.READ_ONLY_FROM = cutoff;
        expect(getReadOnlyCutoffIso()).toBe(cutoff);
      });

      test("returns null when READ_ONLY_FROM is unset", () => {
        delete process.env.READ_ONLY_FROM;
        expect(getReadOnlyCutoffIso()).toBeNull();
      });

      test("returns null when READ_ONLY_FROM is malformed", () => {
        process.env.READ_ONLY_FROM = "garbage";
        expect(getReadOnlyCutoffIso()).toBeNull();
      });
    });

    describe("getRenewalUrl", () => {
      test("returns the URL when RENEWAL_URL is set", () => {
        process.env.RENEWAL_URL = "https://example.com/renew/?t=abc";
        expect(getRenewalUrl()).toBe("https://example.com/renew/?t=abc");
      });

      test("returns null when RENEWAL_URL is unset", () => {
        delete process.env.RENEWAL_URL;
        expect(getRenewalUrl()).toBeNull();
      });
    });
  },
);

describe("parseWarnDays", () => {
  test("returns 14 when undefined", () => {
    expect(parseWarnDays(undefined)).toBe(14);
  });

  test("returns 14 when empty string", () => {
    expect(parseWarnDays("")).toBe(14);
  });

  test("returns the parsed value for valid input", () => {
    expect(parseWarnDays("7")).toBe(7);
  });

  test("returns 14 for zero", () => {
    expect(parseWarnDays("0")).toBe(14);
  });

  test("returns 14 for negative", () => {
    expect(parseWarnDays("-3")).toBe(14);
  });

  test("returns 14 for non-numeric", () => {
    expect(parseWarnDays("abc")).toBe(14);
  });

  test("respects custom default", () => {
    expect(parseWarnDays(undefined, 30)).toBe(30);
  });
});

describe("isReadOnlyFromCutoff", () => {
  test("returns true when now >= cutoff", () => {
    const now = Date.parse("2026-06-01T00:00:00Z");
    expect(isReadOnlyFromCutoff(now, "2026-06-01T00:00:00Z")).toBe(true);
  });

  test("returns true when now > cutoff", () => {
    const now = Date.parse("2026-07-01T00:00:00Z");
    expect(isReadOnlyFromCutoff(now, "2026-06-01T00:00:00Z")).toBe(true);
  });

  test("returns false when now < cutoff", () => {
    const now = Date.parse("2026-05-01T00:00:00Z");
    expect(isReadOnlyFromCutoff(now, "2026-06-01T00:00:00Z")).toBe(false);
  });

  test("returns false for unparseable cutoff", () => {
    expect(isReadOnlyFromCutoff(Date.now(), "not-a-date")).toBe(false);
  });
});

describe("isInWarningWindow", () => {
  const cutoff = "2026-07-01T00:00:00Z";
  const cutoffMs = Date.parse(cutoff);

  test("returns true when inside warning window", () => {
    const now = cutoffMs - 7 * DAY_MS;
    expect(isInWarningWindow(now, cutoff, 14)).toBe(true);
  });

  test("returns false when exactly at cutoff", () => {
    expect(isInWarningWindow(cutoffMs, cutoff, 14)).toBe(false);
  });

  test("returns false when outside warning window", () => {
    const now = cutoffMs - 15 * DAY_MS;
    expect(isInWarningWindow(now, cutoff, 14)).toBe(false);
  });

  test("returns false when now >= cutoff (already expired)", () => {
    const now = cutoffMs + DAY_MS;
    expect(isInWarningWindow(now, cutoff, 14)).toBe(false);
  });

  test("returns true at the exact boundary of warning window", () => {
    const now = cutoffMs - 14 * DAY_MS;
    expect(isInWarningWindow(now, cutoff, 14)).toBe(true);
  });

  test("returns false for unparseable cutoff", () => {
    expect(isInWarningWindow(Date.now(), "garbage", 14)).toBe(false);
  });
});

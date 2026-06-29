/**
 * Tests for the release-tag format shared between build-edge.ts (which
 * writes .build-tag) and src/shared/update.ts (which parses tags from
 * GitHub releases to decide whether a newer version is available).
 *
 * Any drift between these two halves silently breaks self-update, so the
 * roundtrip tests here are the single source of truth for the tag format.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isNewerVersion,
  parseReleaseTag,
  setBuildTimestampForTest,
} from "#shared/update.ts";
import { isoToTag } from "../../scripts/build-tag.ts";

const RELEASE_TAG_FORMAT = /^v\d{4}-\d{2}-\d{2}-\d{6}$/;

describe("isoToTag", () => {
  test("produces the vYYYY-MM-DD-HHMMSS format the release workflow expects", () => {
    expect(isoToTag("2026-03-28T14:30:22.000Z")).toBe("v2026-03-28-143022");
  });

  test("matches the shape parsed by parseReleaseTag", () => {
    const tag = isoToTag(new Date().toISOString());
    expect(tag).toMatch(RELEASE_TAG_FORMAT);
  });

  test("uses UTC so local timezone does not shift the tag", () => {
    const iso = "2026-06-15T23:59:59.000Z";
    const tag = isoToTag(iso);
    expect(tag).toBe("v2026-06-15-235959");
    expect(tag).toBe(isoToTag(new Date(iso).toISOString()));
  });

  test("zero-pads single-digit month/day/hour/minute/second", () => {
    expect(isoToTag("2026-01-02T03:04:05.000Z")).toBe("v2026-01-02-030405");
  });

  test("rounds down sub-second precision (releases are second-resolution)", () => {
    expect(isoToTag("2026-03-28T14:30:22.999Z")).toBe("v2026-03-28-143022");
  });
});

describe("isoToTag / parseReleaseTag roundtrip", () => {
  test("parseReleaseTag recovers the original ISO timestamp (to the second)", () => {
    const iso = "2026-03-28T14:30:22.000Z";
    const parsed = parseReleaseTag(isoToTag(iso));
    expect(parsed).not.toBeNull();
    expect(parsed!.toISOString()).toBe(iso);
  });

  test("roundtrips a freshly built timestamp", () => {
    const now = new Date();
    now.setUTCMilliseconds(0);
    const parsed = parseReleaseTag(isoToTag(now.toISOString()));
    expect(parsed?.getTime()).toBe(now.getTime());
  });

  test("isNewerVersion treats a tag built from a later timestamp as newer", () => {
    setBuildTimestampForTest("2026-01-01T00:00:00.000Z");
    try {
      const newerTag = isoToTag("2026-02-01T00:00:00.000Z");
      expect(isNewerVersion(newerTag)).toBe(true);
    } finally {
      setBuildTimestampForTest(null);
    }
  });

  test("isNewerVersion treats a tag built from the same timestamp as not newer", () => {
    const iso = "2026-03-28T14:30:22.000Z";
    setBuildTimestampForTest(iso);
    try {
      expect(isNewerVersion(isoToTag(iso))).toBe(false);
    } finally {
      setBuildTimestampForTest(null);
    }
  });

  test("isNewerVersion treats an earlier tag as not newer", () => {
    setBuildTimestampForTest("2026-03-01T00:00:00.000Z");
    try {
      const olderTag = isoToTag("2026-01-01T00:00:00.000Z");
      expect(isNewerVersion(olderTag)).toBe(false);
    } finally {
      setBuildTimestampForTest(null);
    }
  });

  test("isNewerVersion returns false (never throws) for an unparseable tag", () => {
    // Guard must short-circuit before dereferencing the null parsed date, even
    // when a real build timestamp is present.
    setBuildTimestampForTest("2026-01-01T00:00:00.000Z");
    try {
      expect(isNewerVersion("not-a-release-tag")).toBe(false);
    } finally {
      setBuildTimestampForTest(null);
    }
  });

  test("isNewerVersion returns false when the build timestamp is empty", () => {
    // Development/source builds carry no timestamp; nothing is ever "newer".
    setBuildTimestampForTest("");
    try {
      const tag = isoToTag("2026-02-01T00:00:00.000Z");
      expect(isNewerVersion(tag)).toBe(false);
    } finally {
      setBuildTimestampForTest(null);
    }
  });
});

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  DEFAULT_ORPHAN_RETENTION,
  isOrphanRetentionValue,
  ORPHAN_RETENTION_OPTIONS,
  orphanRetentionCutoffIso,
} from "#shared/orphan-retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe("orphan-retention", () => {
  describe("isOrphanRetentionValue", () => {
    test("accepts every offered dropdown option", () => {
      for (const option of ORPHAN_RETENTION_OPTIONS) {
        expect(isOrphanRetentionValue(option.value)).toBe(true);
      }
    });

    test("rejects a value that is not an offered option", () => {
      expect(isOrphanRetentionValue("999")).toBe(false);
    });

    test("rejects an empty value", () => {
      expect(isOrphanRetentionValue("")).toBe(false);
    });
  });

  describe("orphanRetentionCutoffIso", () => {
    test("'0' (immediately) yields the current instant so every orphan qualifies", () => {
      expect(orphanRetentionCutoffIso("0", NOW)).toBe(
        new Date(NOW).toISOString(),
      );
    });

    test("subtracts the chosen number of days from now", () => {
      const cutoff = orphanRetentionCutoffIso("182", NOW);
      expect(NOW - new Date(cutoff).getTime()).toBe(182 * DAY_MS);
    });

    test("falls back to the default age for an unrecognised value", () => {
      const cutoff = orphanRetentionCutoffIso("not-a-real-age", NOW);
      const defaultDays = Number.parseInt(DEFAULT_ORPHAN_RETENTION, 10);
      expect(NOW - new Date(cutoff).getTime()).toBe(defaultDays * DAY_MS);
    });
  });

  test("the default retention (6 months) is one of the offered options", () => {
    expect(isOrphanRetentionValue(DEFAULT_ORPHAN_RETENTION)).toBe(true);
  });
});

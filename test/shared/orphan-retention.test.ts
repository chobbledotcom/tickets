import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ChoiceOption } from "#shared/choice.ts";
import {
  DEFAULT_ORPHAN_RETENTION,
  isOrphanRetentionValue,
  ORPHAN_RETENTION_OPTIONS,
  orphanRetentionCutoffIso,
} from "#shared/orphan-retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

/** The exact offered dropdown options, in display order — pins every
 *  labelKey/value literal so a typo'd i18n key or day count is caught here,
 *  not as a missing-translation throw or a silently wrong purge window. */
const EXPECTED_OPTIONS: readonly ChoiceOption[] = [
  { labelKey: "privacy.retention.immediately", value: "0" },
  { labelKey: "privacy.retention.6_months", value: "182" },
  { labelKey: "privacy.retention.1_year", value: "365" },
  { labelKey: "privacy.retention.2_years", value: "730" },
  { labelKey: "privacy.retention.3_years", value: "1095" },
  { labelKey: "privacy.retention.4_years", value: "1460" },
  { labelKey: "privacy.retention.5_years", value: "1825" },
];

describe("orphan-retention", () => {
  test("ORPHAN_RETENTION_OPTIONS has the exact labelKey and value for every offered option, in order", () => {
    expect(ORPHAN_RETENTION_OPTIONS).toEqual(EXPECTED_OPTIONS);
  });

  for (const option of EXPECTED_OPTIONS) {
    test(`orphanRetentionCutoffIso("${option.value}") subtracts exactly ${option.value} days`, () => {
      const cutoff = orphanRetentionCutoffIso(option.value, NOW);
      expect(NOW - new Date(cutoff).getTime()).toBe(
        Number(option.value) * DAY_MS,
      );
    });
  }

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

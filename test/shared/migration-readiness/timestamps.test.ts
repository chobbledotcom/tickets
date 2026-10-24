/**
 * Tests for the legacy timestamp conversion: every stored time column must
 * normalise to the canonical `…sssZ` instant, an unrecoverable value is a
 * contradiction, and the NOT NULL columns may not be empty.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { diagnoseReadiness } from "#shared/migration-readiness/readiness.ts";
import { convertLegacyTimestamp } from "#shared/migration-readiness/timestamps.ts";
import {
  goodInput,
  processed,
  stage,
  sumupCheckout,
} from "#test/shared/migration-readiness/fixtures.ts";

describe("convertLegacyTimestamp", () => {
  test("canonicalises an ISO instant with an offset to …sssZ", () => {
    expect(convertLegacyTimestamp("2026-01-02T03:04:05+00:00")).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });

  test("keeps an already-canonical instant", () => {
    const value = "2026-01-02T03:04:05.123Z";
    expect(convertLegacyTimestamp(value)).toBe(value);
  });

  test("converts an old epoch-millis string to ISO", () => {
    expect(convertLegacyTimestamp("1735689600000")).toBe(
      "2025-01-01T00:00:00.000Z",
    );
  });

  test("treats an empty string as empty", () => {
    expect(convertLegacyTimestamp("")).toBe("");
  });

  test("rejects an impossible calendar date instead of fixing it", () => {
    expect(convertLegacyTimestamp("2026-02-30T00:00:00Z")).toBeNull();
  });

  test("rejects plain text that is not a timestamp", () => {
    expect(convertLegacyTimestamp("not-a-time")).toBeNull();
  });

  test("rejects epoch zero (an unset sentinel, not a real instant)", () => {
    expect(convertLegacyTimestamp("0")).toBeNull();
  });

  test("converts a one-millisecond epoch to ISO", () => {
    expect(convertLegacyTimestamp("1")).toBe("1970-01-01T00:00:00.001Z");
  });

  test("rejects an epoch-millis value outside Date's representable range", () => {
    expect(convertLegacyTimestamp("99999999999999999999")).toBeNull();
  });
});

describe("timestamp conversion in the readiness verdict", () => {
  test("reports an unconvertible timestamp", () => {
    const report = diagnoseReadiness(
      goodInput({
        processed: [processed({ processed_at: "2026-02-30T00:00:00Z" })],
      }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail: "processed_payments.processed_at = 2026-02-30T00:00:00Z",
      kind: "unconvertible_timestamp",
    });
    // The bad processed_at is not counted; the empty provider_refunded_at is not
    // counted either; only the stage and sumup created_at columns convert.
    expect(report.counts.timestampConversions).toBe(2);
  });

  test("blocks on an empty required timestamp (processed_at is NOT NULL)", () => {
    const report = diagnoseReadiness(
      goodInput({
        processed: [processed({ processed_at: "" })],
      }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail: "processed_payments.processed_at = ",
      kind: "unconvertible_timestamp",
    });
  });

  test("does not block on an empty optional timestamp (provider_refunded_at)", () => {
    const report = diagnoseReadiness(
      goodInput({
        processed: [processed({ provider_refunded_at: "" })],
      }),
    );
    expect(
      report.contradictions.some((c) => c.kind === "unconvertible_timestamp"),
    ).toBe(false);
  });

  test("blocks on an empty required checkout_stages.created_at", () => {
    const report = diagnoseReadiness(
      goodInput({
        stages: [stage({ created_at: "" })],
      }),
    );
    expect(
      report.contradictions.some(
        (c) =>
          c.kind === "unconvertible_timestamp" &&
          c.detail.includes("checkout_stages.created_at"),
      ),
    ).toBe(true);
  });

  test("blocks on an empty required sumup_checkouts.created_at", () => {
    const report = diagnoseReadiness(
      goodInput({
        sumup: [sumupCheckout({ created_at: "" })],
      }),
    );
    expect(
      report.contradictions.some(
        (c) =>
          c.kind === "unconvertible_timestamp" &&
          c.detail.includes("sumup_checkouts.created_at"),
      ),
    ).toBe(true);
  });

  test("counts timestamp conversions actually performed", () => {
    const report = diagnoseReadiness(goodInput());
    // processed_at + provider_refunded_at + checkout_stages.created_at +
    // sumup_checkouts.created_at — the goodInput rows all carry real instants.
    expect(report.counts.timestampConversions).toBe(4);
  });
});

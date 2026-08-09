import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildPaymentGroups,
  convertLegacyTimestamp,
  diagnoseReadiness,
  LEGACY_MERGE_SESSION_PREFIX,
} from "#shared/migration-readiness/readiness.ts";
import {
  enc,
  goodInput,
  mergeRefNoOwnerInput,
  processed,
  stage,
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
});

describe("buildPaymentGroups", () => {
  test("groups processed payments and stages by payment session id", () => {
    const groups = buildPaymentGroups(
      [processed({ payment_session_id: "a" })],
      [stage({ payment_session_id: "a" }), stage({ payment_session_id: "b" })],
    );
    expect(groups.map((g) => g.paymentSessionId)).toEqual(["a", "b"]);
    expect(groups[0]!.processed?.payment_session_id).toBe("a");
    expect(groups[0]!.stage?.payment_session_id).toBe("a");
    expect(groups[1]!.processed).toBeNull();
    expect(groups[1]!.stage?.payment_session_id).toBe("b");
  });

  test("preserves insertion order of the first time a session is seen", () => {
    const groups = buildPaymentGroups(
      [
        processed({ payment_session_id: "b" }),
        processed({ payment_session_id: "a" }),
      ],
      [],
    );
    expect(groups.map((g) => g.paymentSessionId)).toEqual(["b", "a"]);
  });
});

describe("diagnoseReadiness", () => {
  test("reports ready when every source is consistent and the owner key works", () => {
    const report = diagnoseReadiness(goodInput());
    expect(report.kind).toBe("ready");
    expect(report.contradictions).toEqual([]);
    expect(report.counts.processedPayments).toBe(1);
    expect(report.counts.checkoutStages).toBe(1);
    expect(report.counts.sumupCheckouts).toBe(1);
    expect(report.counts.attendeePiiBlobs).toBe(1);
    expect(report.counts.paymentGroups).toBe(1);
  });

  test("blocks when a checkout stage has no processed payment", () => {
    const report = diagnoseReadiness(
      goodInput({ stages: [stage({ payment_session_id: "orphan" })] }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail: "orphan",
      kind: "checkout_stage_without_processed_payment",
    });
  });

  test("blocks when a processed payment points at a missing attendee", () => {
    const report = diagnoseReadiness(
      goodInput({ processed: [processed({ attendee_id: 99 })] }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail: "99",
      kind: "processed_payment_without_attendee",
    });
  });

  test("blocks when a processed payment has a null attendee id (unresolved reservation)", () => {
    const report = diagnoseReadiness(
      goodInput({ processed: [processed({ attendee_id: null })] }),
    );
    expect(report.kind).toBe("blocked");
    expect(
      report.contradictions.some(
        (c) => c.kind === "processed_payment_without_attendee",
      ),
    ).toBe(true);
  });

  test("does not block a terminal failure (null attendee + failure_data set)", () => {
    const report = diagnoseReadiness(
      goodInput({
        processed: [
          processed({
            attendee_id: null,
            failure_data: "enc:1:failure" as never,
          }),
        ],
      }),
    );
    expect(
      report.contradictions.some(
        (c) => c.kind === "processed_payment_without_attendee",
      ),
    ).toBe(false);
  });

  test("blocks when a checkout stage points at a deleted attendee", () => {
    const report = diagnoseReadiness(
      goodInput({
        attendeeIds: new Set([1]),
        stages: [stage({ attendee_id: 99 })],
      }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail: "99",
      kind: "checkout_stage_without_attendee",
    });
  });

  test("a legitimate merge reference (source deleted, target live) does not block", () => {
    // applyAttendeeMerge deletes the source attendee and writes
    // legacy-merge:<sourceId> with attendee_id = target. The source id is
    // historical, so its absence must NOT be a contradiction.
    const ref = `${LEGACY_MERGE_SESSION_PREFIX}5`;
    const report = diagnoseReadiness(
      goodInput({
        attendeeIds: new Set([1]),
        attendees: [
          { id: 1, pii_blob: enc("hyb:1:x") },
          { id: 2, pii_blob: enc("hyb:1:y") },
        ],
        processed: [
          processed({ attendee_id: 1, payment_session_id: ref }),
          processed({ payment_session_id: "sess-1" }),
        ],
      }),
    );
    expect(report.counts.mergeReferences).toBe(1);
    expect(report.kind).toBe("ready");
    expect(report.contradictions).toEqual([]);
  });

  test("blocks when a merge reference's target attendee is missing", () => {
    const ref = `${LEGACY_MERGE_SESSION_PREFIX}2`;
    const report = diagnoseReadiness(
      goodInput({
        attendeeIds: new Set([1, 2]),
        processed: [processed({ attendee_id: 9, payment_session_id: ref })],
      }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail: "9",
      kind: "processed_payment_without_attendee",
    });
  });

  test("blocks rather than skipping PII when no owner key is available", () => {
    const report = diagnoseReadiness(goodInput({ ownerKeyAvailable: false }));
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail:
        "1 encrypted attendee PII blob(s) and no payment references cannot be verified without the owner key",
      kind: "owner_key_unavailable",
    });
  });

  test("blocks on encrypted merge-reference charges when no owner key is available, even with no PII", () => {
    const ref = `${LEGACY_MERGE_SESSION_PREFIX}2`;
    const report = diagnoseReadiness(
      mergeRefNoOwnerInput(ref, enc("hyb:1:charge")),
    );
    expect(report.kind).toBe("blocked");
    expect(
      report.contradictions.some((c) => c.kind === "owner_key_unavailable"),
    ).toBe(true);
    expect(
      report.contradictions.find((c) => c.kind === "owner_key_unavailable")
        ?.detail,
    ).toContain("encrypted payment reference(s)");
  });

  test("does not block on a merge reference when the charge is empty and no owner key is supplied", () => {
    const ref = `${LEGACY_MERGE_SESSION_PREFIX}2`;
    const report = diagnoseReadiness(mergeRefNoOwnerInput(ref, ""));
    expect(
      report.contradictions.some((c) => c.kind === "owner_key_unavailable"),
    ).toBe(false);
  });

  test("does not report a missing owner key when there is no PII to check", () => {
    const report = diagnoseReadiness(
      goodInput({
        attendees: [],
        ownerKeyAvailable: false,
      }),
    );
    expect(
      report.contradictions.some((c) => c.kind === "owner_key_unavailable"),
    ).toBe(false);
  });

  test("reports attendee PII that fails to decrypt with the owner key", () => {
    const report = diagnoseReadiness(
      goodInput({
        attendeeIds: new Set([1, 7]),
        attendees: [{ id: 7, pii_blob: enc("hyb:1:bad") }],
        undecryptablePii: new Set([7]),
      }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail: "attendee 7",
      kind: "undecryptable_attendee_pii",
    });
  });

  test("reports a merge reference whose payment reference fails to decrypt", () => {
    const ref = `${LEGACY_MERGE_SESSION_PREFIX}1`;
    const report = diagnoseReadiness(
      goodInput({
        processed: [
          processed({
            attendee_id: 1,
            payment_reference: enc("hyb:1:x"),
            payment_session_id: ref,
          }),
          processed({ payment_session_id: "sess-1" }),
        ],
        undecryptablePaymentReferences: new Set([ref]),
      }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail: ref,
      kind: "undecryptable_merge_reference",
    });
  });

  test("reports a regular captured charge reference that fails to decrypt", () => {
    // A non-merge payment_session_id whose payment_reference failed to decrypt
    // is classified as undecryptable_payment_reference (distinct from a merge-
    // reference charge).
    const report = diagnoseReadiness(
      goodInput({
        processed: [
          processed({
            attendee_id: 1,
            payment_reference: enc("hyb:1:charge"),
            payment_session_id: "sess-1",
          }),
        ],
        undecryptablePaymentReferences: new Set(["sess-1"]),
      }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail: "sess-1",
      kind: "undecryptable_payment_reference",
    });
  });

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

  test("reports a sumup checkout row whose id was never recorded", () => {
    const report = diagnoseReadiness(
      goodInput({
        sumup: [
          {
            created_at: "2026-01-01T00:00:00.000Z",
            reference_index: "idx",
            sumup_id: "",
          },
        ],
      }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail: "idx",
      kind: "sumup_checkout_without_id",
    });
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
    const ref = `${LEGACY_MERGE_SESSION_PREFIX}2`;
    const report = diagnoseReadiness(
      goodInput({
        attendeeIds: new Set([1]),
        attendees: [{ id: 1, pii_blob: "" }],
        ownerKeyAvailable: false,
        processed: [processed({ attendee_id: 1, payment_session_id: ref })],
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
        sumup: [{ created_at: "", reference_index: "idx", sumup_id: "su" }],
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

  test("rejects an epoch-millis value outside Date's representable range", () => {
    expect(convertLegacyTimestamp("99999999999999999999")).toBeNull();
  });

  test("counts timestamp conversions actually performed", () => {
    const report = diagnoseReadiness(goodInput());
    // processed_at + provider_refunded_at + checkout_stages.created_at +
    // sumup_checkouts.created_at — the goodInput rows all carry real instants.
    expect(report.counts.timestampConversions).toBe(4);
  });
  test("is ready with an empty-blob attendee and no owner key (nothing encrypted to skip)", () => {
    const report = diagnoseReadiness(
      goodInput({
        attendees: [{ id: 1, pii_blob: "" }],
        ownerKeyAvailable: false,
      }),
    );
    expect(report.kind).toBe("ready");
    expect(report.contradictions).toEqual([]);
  });

  test("is ready when a single consistent payment is read with a small page size", () => {
    // The page-split check is gone: payment_session_id is a primary key, so a
    // single payment can never appear more than once per table, and a keyset
    // page over one table can't split it. (Split detection is a PR 14 copy-
    // cursor concern, not this read-only verifier.)
    const report = diagnoseReadiness(goodInput());
    expect(report.kind).toBe("ready");
  });
});

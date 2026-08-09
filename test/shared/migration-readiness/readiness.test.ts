import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { OwnerKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  buildPaymentGroups,
  type CheckoutStageRow,
  convertLegacyTimestamp,
  type DiagnoseInput,
  diagnoseReadiness,
  formatReadinessReport,
  LEGACY_MERGE_SESSION_PREFIX,
  type ProcessedPaymentRow,
} from "#shared/migration-readiness/readiness.ts";

const enc = (s: string): OwnerKeyEncrypted => s as OwnerKeyEncrypted;

const stage = (over: Partial<CheckoutStageRow>): CheckoutStageRow => ({
  attendee_id: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  payment_session_id: "sess-1",
  provider: "stripe",
  state: "completed",
  ...over,
});

const processed = (
  over: Partial<ProcessedPaymentRow>,
): ProcessedPaymentRow => ({
  attendee_id: 1,
  payment_reference: "",
  payment_session_id: "sess-1",
  processed_at: "2026-01-01T00:00:00.000Z",
  provider_refunded_at: "",
  ...over,
});

const goodInput = (over: Partial<DiagnoseInput> = {}): DiagnoseInput => ({
  attendeeIds: new Set([1]),
  attendees: [{ id: 1, pii_blob: enc("hyb:1:x") }],
  orderedProcessedSessionIds: ["sess-1"],
  ownerKeyAvailable: true,
  pageSize: 500,
  processed: [processed({ provider_refunded_at: "2026-01-02T00:00:00.000Z" })],
  stages: [stage({})],
  sumup: [
    {
      created_at: "2026-01-01T00:00:00.000Z",
      reference_index: "idx-1",
      sumup_id: "su-1",
    },
  ],
  undecryptableMergeReferences: new Set(),
  undecryptablePii: new Set(),
  ...over,
});

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

  test("blocks when a processed payment has a null attendee id", () => {
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

  test("blocks when a merged migration page is mistaken for end of input", () => {
    const ref = `${LEGACY_MERGE_SESSION_PREFIX}5`;
    const report = diagnoseReadiness(
      goodInput({
        attendeeIds: new Set([1]),
        attendees: [
          { id: 1, pii_blob: enc("hyb:1:x") },
          { id: 2, pii_blob: enc("hyb:1:y") },
        ],
        orderedProcessedSessionIds: [ref, "sess-1"],
        processed: [
          processed({ attendee_id: 1, payment_session_id: ref }),
          processed({ payment_session_id: "sess-1" }),
        ],
      }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.counts.mergeReferences).toBe(1);
    expect(report.contradictions).toContainEqual({
      detail: ref,
      kind: "merge_reference_without_source_attendee",
    });
  });

  test("blocks when a merge reference target attendee is missing", () => {
    const ref = `${LEGACY_MERGE_SESSION_PREFIX}2`;
    const report = diagnoseReadiness(
      goodInput({
        attendeeIds: new Set([1, 2]),
        orderedProcessedSessionIds: [ref],
        processed: [processed({ attendee_id: 9, payment_session_id: ref })],
      }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail: ref,
      kind: "merge_reference_without_target_attendee",
    });
  });

  test("blocks rather than skipping PII when no owner key is available", () => {
    const report = diagnoseReadiness(goodInput({ ownerKeyAvailable: false }));
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail:
        "1 encrypted attendee PII blob(s) cannot be verified without the owner key",
      kind: "owner_key_unavailable",
    });
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
        orderedProcessedSessionIds: [ref, "sess-1"],
        processed: [
          processed({
            attendee_id: 1,
            payment_reference: enc("hyb:1:x"),
            payment_session_id: ref,
          }),
          processed({ payment_session_id: "sess-1" }),
        ],
        undecryptableMergeReferences: new Set([ref]),
      }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail: ref,
      kind: "undecryptable_merge_reference",
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

  test("reports a provider payment split across a keyset page", () => {
    const report = diagnoseReadiness(
      goodInput({
        orderedProcessedSessionIds: ["sess-1", "sess-1"],
        pageSize: 1,
      }),
    );
    expect(report.kind).toBe("blocked");
    expect(report.contradictions).toContainEqual({
      detail: "sess-1",
      kind: "payment_split_across_page",
    });
  });

  test("counts timestamp conversions actually performed", () => {
    const report = diagnoseReadiness(goodInput());
    expect(report.counts.timestampConversions).toBeGreaterThan(0);
  });
});

describe("formatReadinessReport", () => {
  test("states ready with exact source counts and the owner-key verdict", () => {
    const report = diagnoseReadiness(goodInput());
    expect(formatReadinessReport(report)).toEqual([
      "Payment migration readiness: ready",
      "",
      "Source counts",
      "  processed_payments rows: 1",
      "  checkout_stages rows: 1",
      "  sumup_checkouts rows: 1",
      "  attendee PII blobs: 1",
      "  merge references: 0",
      "  payment groups: 1",
      "  timestamps converted: 4",
      "",
      "Owner key",
      "  verified 1 of 1 attendee PII blob(s)",
      "",
    ]);
  });

  test("states blocked and lists the owner-key contradiction in plain language", () => {
    const report = diagnoseReadiness(goodInput({ ownerKeyAvailable: false }));
    expect(formatReadinessReport(report)).toEqual([
      "Payment migration readiness: BLOCKED — 1 contradiction(s)",
      "",
      "Source counts",
      "  processed_payments rows: 1",
      "  checkout_stages rows: 1",
      "  sumup_checkouts rows: 1",
      "  attendee PII blobs: 1",
      "  merge references: 0",
      "  payment groups: 1",
      "  timestamps converted: 4",
      "",
      "Owner key",
      "  not supplied — 1 attendee PII blob(s) cannot be verified",
      "",
      "Contradictions",
      "  - owner key not supplied: 1 encrypted attendee PII blob(s) cannot be verified without the owner key",
    ]);
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

  test("is ready when each payment appears once even at a page size of one", () => {
    const report = diagnoseReadiness(goodInput({ pageSize: 1 }));
    expect(report.kind).toBe("ready");
  });

  test("lists every contradiction phrase when each kind fires", () => {
    const ref = `${LEGACY_MERGE_SESSION_PREFIX}99`;
    const report = diagnoseReadiness({
      attendeeIds: new Set([1, 7]),
      attendees: [{ id: 7, pii_blob: enc("hyb:1:p") }],
      orderedProcessedSessionIds: ["x", "x", "x", ref, "sess-1"],
      ownerKeyAvailable: true,
      pageSize: 1,
      processed: [
        processed({
          attendee_id: 88,
          payment_reference: enc("hyb:1:charge"),
          payment_session_id: ref,
          processed_at: "not-a-time",
        }),
        processed({ payment_session_id: "sess-1" }),
      ],
      stages: [stage({ payment_session_id: "orphan" })],
      sumup: [
        {
          created_at: "2026-01-01T00:00:00.000Z",
          reference_index: "idx",
          sumup_id: "",
        },
      ],
      undecryptableMergeReferences: new Set([ref]),
      undecryptablePii: new Set([7]),
    });
    const out = formatReadinessReport(report).join("\n");
    expect(out).toContain("Contradictions");
    expect(out).toContain(
      "  - checkout stage without a processed payment: orphan",
    );
    expect(out).toContain("  - processed payment without a live attendee: 88");
    expect(out).toContain(
      "  - merge reference without its source attendee: legacy-merge:99",
    );
    expect(out).toContain(
      "  - merge reference without its target attendee: legacy-merge:99",
    );
    expect(out).toContain("  - provider payment split across a page: x");
    expect(out).toContain("  - sumup checkout without a recorded id: idx");
    expect(out).toContain("  - attendee PII that did not decrypt: attendee 7");
    expect(out).toContain(
      "  - merge-reference charge that did not decrypt: legacy-merge:99",
    );
    expect(out).toContain("  - timestamp that cannot be converted:");
  });

  test("does not leak attendee PII plaintext into the detail", () => {
    const report = diagnoseReadiness(
      goodInput({
        attendeeIds: new Set([1, 7]),
        attendees: [{ id: 7, pii_blob: enc("hyb:1:super-secret") }],
        undecryptablePii: new Set([7]),
      }),
    );
    const lines = formatReadinessReport(report).join("\n");
    expect(lines).toContain("attendee 7");
    expect(lines).not.toContain("super-secret");
  });
});

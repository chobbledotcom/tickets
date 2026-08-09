import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatReadinessReport } from "#shared/migration-readiness/format.ts";
import {
  diagnoseReadiness,
  LEGACY_MERGE_SESSION_PREFIX,
} from "#shared/migration-readiness/readiness.ts";
import {
  enc,
  goodInput,
  processed,
  stage,
} from "#test/shared/migration-readiness/fixtures.ts";

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
      "  - owner key not supplied: 1 encrypted attendee PII blob(s) and no payment references cannot be verified without the owner key",
    ]);
  });

  test("lists every contradiction phrase when each kind fires", () => {
    const ref = `${LEGACY_MERGE_SESSION_PREFIX}99`;
    const report = diagnoseReadiness({
      attendeeIds: new Set([1, 7]),
      attendees: [{ id: 7, pii_blob: enc("hyb:1:p") }],
      ownerKeyAvailable: true,
      processed: [
        processed({
          attendee_id: 88,
          payment_reference: enc("hyb:1:charge"),
          payment_session_id: ref,
          processed_at: "not-a-time",
        }),
        processed({
          attendee_id: 1,
          payment_reference: enc("hyb:1:regular"),
          payment_session_id: "sess-1",
        }),
      ],
      stages: [
        stage({ attendee_id: 66, payment_session_id: "orphan" }),
        stage({ attendee_id: 7, payment_session_id: "sess-1" }),
      ],
      sumup: [
        {
          created_at: "2026-01-01T00:00:00.000Z",
          reference_index: "idx",
          sumup_id: "",
        },
      ],
      undecryptablePaymentReferences: new Set([ref, "sess-1"]),
      undecryptablePii: new Set([7]),
    });
    const out = formatReadinessReport(report).join("\n");
    expect(out).toContain("Contradictions");
    expect(out).toContain(
      "  - checkout stage without a processed payment: orphan",
    );
    expect(out).toContain("  - checkout stage without a live attendee: 66");
    expect(out).toContain(
      "  - checkout stage and processed payment disagree on attendee: 7 vs 1",
    );
    expect(out).toContain("  - processed payment without a live attendee: 88");
    expect(out).toContain("  - sumup checkout without a recorded id: idx");
    expect(out).toContain("  - attendee PII that did not decrypt: attendee 7");
    expect(out).toContain(
      "  - merge-reference charge that did not decrypt: legacy-merge:99",
    );
    expect(out).toContain(
      "  - captured charge reference that did not decrypt: sess-1",
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

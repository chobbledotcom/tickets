/**
 * Tests for the report formatter: the ready heading, the blocked heading
 * with its contradiction count, one block per contradiction — the kind and
 * evidence, the meaning, the suggested action — and the source counts.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { formatReport } from "#shared/migration-readiness/format.ts";
import {
  type Contradiction,
  type ContradictionKind,
  diagnoseReadiness,
} from "#shared/migration-readiness/readiness.ts";
import { goodInput } from "#test/shared/migration-readiness/fixtures.ts";

const ALL_KINDS: readonly ContradictionKind[] = [
  "checkout_stage_without_processed_payment",
  "checkout_stage_attendee_mismatch",
  "checkout_stage_without_attendee",
  "processed_payment_without_attendee",
  "undecryptable_attendee_pii",
  "undecryptable_payment_reference",
  "undecryptable_merge_reference",
  "undecryptable_ticket_tokens",
  "undecryptable_failure_data",
  "owner_key_unavailable",
  "unconvertible_timestamp",
  "sumup_checkout_without_id",
  "sumup_checkout_without_staging_ciphertext",
];

describe("formatReport", () => {
  test("formats a ready verdict with the read counts", () => {
    expect(formatReport(diagnoseReadiness(goodInput()))).toEqual([
      "Payment migration readiness: ready",
      "Read 1 processed payments, 1 checkout stages, 1 sumup checkouts, " +
        "1 attendee details, 0 merge references, 1 payment groups, " +
        "4 timestamps.",
    ]);
  });

  test("formats a blocked verdict with the contradiction count", () => {
    const report = diagnoseReadiness(
      goodInput({
        stages: [
          {
            attendee_id: 1,
            created_at: "2026-01-01T00:00:00.000Z",
            payment_session_id: "sess-1",
          },
          {
            attendee_id: 2,
            created_at: "2026-01-01T00:00:00.000Z",
            payment_session_id: "sess-2",
          },
        ],
      }),
    );
    const lines = formatReport(report);
    expect(lines[0]).toBe(
      "Payment migration readiness: BLOCKED — 2 contradiction(s)",
    );
  });

  test("formats one contradiction with its evidence, meaning, and action", () => {
    const lines = formatReport({
      contradictions: [
        {
          detail: "sess-9",
          kind: "checkout_stage_without_processed_payment",
        },
      ],
      counts: {
        attendeePiiBlobs: 0,
        checkoutStages: 1,
        mergeReferences: 0,
        paymentGroups: 1,
        processedPayments: 0,
        sumupCheckouts: 0,
        timestampConversions: 0,
      },
      kind: "blocked",
    });
    expect(lines).toEqual([
      "Payment migration readiness: BLOCKED — 1 contradiction(s)",
      "  - checkout_stage_without_processed_payment: sess-9",
      "      A checkout stage row has no processed payment with the same session id.",
      "      Read the session in the legacy tables. Remove the stage row or restore its processed payment before you migrate.",
      "Read 0 processed payments, 1 checkout stages, 0 sumup checkouts, " +
        "0 attendee details, 0 merge references, 1 payment groups, 0 timestamps.",
    ]);
  });

  test("formats the restored timestamp contradiction with its action", () => {
    const lines = formatReport({
      contradictions: [
        {
          detail: "processed_payments.processed_at = 2026-02-30T00:00:00Z",
          kind: "unconvertible_timestamp",
        },
      ],
      counts: {
        attendeePiiBlobs: 0,
        checkoutStages: 0,
        mergeReferences: 0,
        paymentGroups: 0,
        processedPayments: 1,
        sumupCheckouts: 0,
        timestampConversions: 0,
      },
      kind: "blocked",
    });
    expect(lines).toContain(
      "  - unconvertible_timestamp: processed_payments.processed_at = 2026-02-30T00:00:00Z",
    );
    expect(lines).toContain(
      "      A stored timestamp is not a real instant, or a required timestamp column is empty.",
    );
    expect(lines).toContain(
      "      Fix the stored value in the named column, so the forward copy can convert it.",
    );
  });

  test("formats every contradiction kind with a meaning and an action", () => {
    for (const kind of ALL_KINDS) {
      const contradiction: Contradiction = { detail: "evidence-1", kind };
      const lines = formatReport({
        contradictions: [contradiction],
        counts: {
          attendeePiiBlobs: 0,
          checkoutStages: 0,
          mergeReferences: 0,
          paymentGroups: 0,
          processedPayments: 0,
          sumupCheckouts: 0,
          timestampConversions: 0,
        },
        kind: "blocked",
      });
      expect(lines.slice(1, 2)).toEqual([`  - ${kind}: evidence-1`]);
      expect(lines.slice(2, 4).every((line) => line.trim() !== "")).toBe(true);
    }
  });
});

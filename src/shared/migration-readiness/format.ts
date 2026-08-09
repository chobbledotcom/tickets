/**
 * Plain-language rendering of a migration-readiness verdict.
 *
 * Split out of `readiness.ts` so the pure diagnosis rules and the operator
 * report rendering stay under the ~400-line file target each. The report
 * carries only non-secret identifying context (payment session ids, attendee
 * ids, counts) — never PII plaintext.
 */

import type {
  ContradictionKind,
  ReadinessReport,
} from "#shared/migration-readiness/readiness.ts";

const CONTRADICTION_PHRASES: Record<ContradictionKind, string> = {
  checkout_stage_attendee_mismatch:
    "checkout stage and processed payment disagree on attendee",
  checkout_stage_without_attendee: "checkout stage without a live attendee",
  checkout_stage_without_processed_payment:
    "checkout stage without a processed payment",
  owner_key_unavailable: "owner key not supplied",
  processed_payment_without_attendee:
    "processed payment without a live attendee",
  sumup_checkout_without_id: "sumup checkout without a recorded id",
  unconvertible_timestamp: "timestamp that cannot be converted",
  undecryptable_attendee_pii: "attendee PII that did not decrypt",
  undecryptable_merge_reference: "merge-reference charge that did not decrypt",
  undecryptable_payment_reference:
    "captured charge reference that did not decrypt",
};

/** Render a readiness verdict as plain operator lines. The owner-key line says
 *  how many PII blobs were verified (or that the key was not supplied), and the
 *  contradiction lines use plain phrases over non-secret detail only. */
export const formatReadinessReport = (report: ReadinessReport): string[] => {
  const lines: string[] = [];
  const heading =
    report.kind === "ready"
      ? "Payment migration readiness: ready"
      : `Payment migration readiness: BLOCKED — ${report.contradictions.length} contradiction(s)`;
  lines.push(heading, "");
  lines.push(
    "Source counts",
    `  processed_payments rows: ${report.counts.processedPayments}`,
    `  checkout_stages rows: ${report.counts.checkoutStages}`,
    `  sumup_checkouts rows: ${report.counts.sumupCheckouts}`,
    `  attendee PII blobs: ${report.counts.attendeePiiBlobs}`,
    `  merge references: ${report.counts.mergeReferences}`,
    `  payment groups: ${report.counts.paymentGroups}`,
    `  timestamps converted: ${report.counts.timestampConversions}`,
    "",
  );
  const ownerKeyMissing = report.contradictions.some(
    (c) => c.kind === "owner_key_unavailable",
  );
  if (ownerKeyMissing) {
    lines.push(
      "Owner key",
      `  not supplied — ${report.counts.attendeePiiBlobs} attendee PII blob(s) cannot be verified`,
      "",
    );
  } else if (report.counts.attendeePiiBlobs > 0) {
    const verified =
      report.counts.attendeePiiBlobs -
      report.contradictions.filter(
        (c) => c.kind === "undecryptable_attendee_pii",
      ).length;
    lines.push(
      "Owner key",
      `  verified ${verified} of ${report.counts.attendeePiiBlobs} attendee PII blob(s)`,
      "",
    );
  }
  if (report.contradictions.length > 0) {
    lines.push("Contradictions");
    for (const { detail, kind } of report.contradictions) {
      lines.push(`  - ${CONTRADICTION_PHRASES[kind]}: ${detail}`);
    }
  }
  return lines;
};

/**
 * The operator-readable form of a migration-readiness verdict: one heading,
 * one block per contradiction — what it means, the evidence, the suggested
 * action — and the source counts. Pure data in, lines out, so the tests pin
 * every line. The CLI prints the lines unchanged.
 */

import type {
  Contradiction,
  ContradictionKind,
  ReadinessReport,
} from "#shared/migration-readiness/readiness.ts";

/** What one contradiction kind means, and what the operator does about it.
 *  Every kind carries an entry. A new kind without one fails to compile. */
const KIND_TEXT: Readonly<
  Record<ContradictionKind, { action: string; meaning: string }>
> = {
  checkout_stage_attendee_mismatch: {
    action:
      "One of the two rows is corrupt. Repair the rows so both name the same attendee before you migrate.",
    meaning:
      "A checkout stage and its processed payment name different attendees.",
  },
  checkout_stage_without_attendee: {
    action:
      "Remove the stage row, or restore the attendee it names, before you migrate.",
    meaning: "A checkout stage row names an attendee that does not exist.",
  },
  checkout_stage_without_processed_payment: {
    action:
      "Read the session in the legacy tables. Remove the stage row or restore its processed payment before you migrate.",
    meaning:
      "A checkout stage row has no processed payment with the same session id.",
  },
  owner_key_unavailable: {
    action:
      "Run again with --owner and the owner password, so the verifier reads every encrypted value.",
    meaning:
      "The database holds encrypted attendee data, and the verifier ran without the owner key.",
  },
  processed_payment_without_attendee: {
    action:
      "Restore the attendee, or record the payment's terminal outcome, before you migrate.",
    meaning:
      "A processed payment that is not a handled terminal failure names an attendee that does not exist.",
  },
  sumup_checkout_without_id: {
    action: "Repair or remove the staging row before you migrate.",
    meaning: "A sumup staging row carries no sumup id.",
  },
  sumup_checkout_without_staging_ciphertext: {
    action:
      "Repair the staging row. Without both columns the booking metadata is unrecoverable.",
    meaning:
      "A sumup staging row is missing its encrypted key or its booking metadata.",
  },
  unconvertible_timestamp: {
    action:
      "Fix the stored value in the named column, so the forward copy can convert it.",
    meaning:
      "A stored timestamp is not a real instant, or a required timestamp column is empty.",
  },
  undecryptable_attendee_pii: {
    action:
      "Run again with the correct owner key, or repair the blob, before you migrate.",
    meaning: "An attendee PII blob did not decrypt under the owner key.",
  },
  undecryptable_failure_data: {
    action:
      "Repair the stored payload before you migrate. The row is not a proven handled failure.",
    meaning:
      "A payment's terminal-failure payload did not decrypt or parse with the database key.",
  },
  undecryptable_merge_reference: {
    action: "Verify the charge with the correct owner key before you migrate.",
    meaning:
      "A merge-reference charge's payment reference did not decrypt under the owner key.",
  },
  undecryptable_payment_reference: {
    action: "Verify the charge with the correct owner key before you migrate.",
    meaning:
      "A captured charge's payment reference did not decrypt under the owner key.",
  },
  undecryptable_ticket_tokens: {
    action:
      "Repair the stored tokens, or accept their loss for this payment, before you migrate.",
    meaning:
      "A payment's encrypted ticket tokens did not decrypt with the database key.",
  },
};

/** The lines one contradiction prints: the kind and its non-secret evidence,
 *  then what the finding means, then the suggested action. */
const formatContradiction = (contradiction: Contradiction): string[] => {
  const { action, meaning } = KIND_TEXT[contradiction.kind];
  return [
    `  - ${contradiction.kind}: ${contradiction.detail}`,
    `      ${meaning}`,
    `      ${action}`,
  ];
};

/** Format the whole verdict. The heading names the verdict and, when it is
 *  blocked, the contradiction count. The counts line names what the verifier
 *  read, so the operator can compare it with the legacy tables. */
export const formatReport = (report: ReadinessReport): string[] => {
  const lines = [
    report.kind === "ready"
      ? "Payment migration readiness: ready"
      : `Payment migration readiness: BLOCKED — ${report.contradictions.length} contradiction(s)`,
  ];
  for (const contradiction of report.contradictions) {
    lines.push(...formatContradiction(contradiction));
  }
  const c = report.counts;
  lines.push(
    `Read ${c.processedPayments} processed payments, ` +
      `${c.checkoutStages} checkout stages, ${c.sumupCheckouts} sumup checkouts, ` +
      `${c.attendeePiiBlobs} attendee details, ${c.mergeReferences} merge references, ` +
      `${c.paymentGroups} payment groups, ${c.timestampConversions} timestamps.`,
  );
  return lines;
};

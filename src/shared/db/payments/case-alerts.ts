import type { InValue } from "@libsql/client";
import * as v from "valibot";
import { queryOne } from "#shared/db/client.ts";
import { claimDatabaseRow } from "#shared/db/lease.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

const DATABASE_NOW_MS =
  "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export type PaymentCaseAlertClaim = {
  alertRevision: number;
  caseId: number;
  leaseToken: string;
};

const AlertClaimRowSchema = v.strictObject({
  alerted_revision: integerAtLeast(1),
  id: integerAtLeast(1),
});

const lostAlertLease = (claim: PaymentCaseAlertClaim): Error =>
  new Error(`Lost payment case alert lease for ${claim.caseId}`);

/** Claim the oldest unsent needs-action intent without decrypting case data. */
export const claimNextPaymentCaseAlert = async (
  leaseMs: number,
): Promise<PaymentCaseAlertClaim | null> =>
  claimDatabaseRow(leaseMs)(
    (lease) =>
      queryOne<{ alerted_revision: number; id: number }>(
        `UPDATE payment_cases AS paymentCase
            SET alert_lease_token = ?,
                alert_lease_expires_at = ${DATABASE_NOW_MS} + ?
          WHERE paymentCase.id = (
            SELECT candidate.id
              FROM payment_cases AS candidate
             WHERE candidate.state = 'needs_action'
               AND candidate.alerted_revision IS NOT NULL
               AND candidate.alert_sent_revision IS NULL
               AND (candidate.alert_lease_token IS NULL
                 OR candidate.alert_lease_expires_at <= ${DATABASE_NOW_MS})
             ORDER BY candidate.alerted_at, candidate.id
             LIMIT 1
          )
          RETURNING id, alerted_revision`,
        [lease.token, lease.duration],
      ),
    (raw) => v.parse(AlertClaimRowSchema, raw),
    (row, leaseToken) => ({
      alertRevision: row.alerted_revision,
      caseId: row.id,
      leaseToken,
    }),
  );

const updatePaymentCaseAlert =
  (changes: string, requirement = "") =>
  async (
    claim: PaymentCaseAlertClaim,
    values: readonly InValue[],
  ): Promise<void> => {
    const row = await queryOne<{ id: number }>(
      `UPDATE payment_cases
          ${changes}
        WHERE id = ?
          ${requirement}
          AND alerted_revision = ?
          AND alert_sent_revision IS NULL
          AND alert_lease_token = ?
        RETURNING id`,
      [...values, claim.caseId, claim.alertRevision, claim.leaseToken],
    );
    if (row === null) throw lostAlertLease(claim);
  };

const markAlertSent = updatePaymentCaseAlert(
  `SET alert_sent_at = ?,
       alert_sent_revision = alerted_revision,
       alert_lease_token = NULL,
       alert_lease_expires_at = NULL`,
  "AND state = 'needs_action'",
);

const releaseAlert = updatePaymentCaseAlert(
  `SET alert_lease_token = NULL,
       alert_lease_expires_at = NULL`,
);

export const markPaymentCaseAlertSent = async (
  claim: PaymentCaseAlertClaim,
  sentAt = Date.now(),
): Promise<void> => {
  const at = v.parse(integerAtLeast(0), sentAt);
  await markAlertSent(claim, [at]);
};

export const releasePaymentCaseAlert = async (
  claim: PaymentCaseAlertClaim,
): Promise<void> => {
  await releaseAlert(claim, []);
};

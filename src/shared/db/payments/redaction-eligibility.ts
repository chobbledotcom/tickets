export interface PaymentRedactionEligibility {
  args: number[];
  sql: string;
}

export const paymentRedactionEligibility = (
  cutoff: number,
): PaymentRedactionEligibility => ({
  args: [cutoff, cutoff, cutoff, cutoff, cutoff],
  sql: `paymentSession.updated_at < ?
    AND paymentSession.redacted_at IS NULL
    AND paymentSession.lease_token IS NULL
    AND paymentSession.lease_expires_at IS NULL
    AND paymentSession.next_reconcile_at IS NULL
    AND paymentSession.ticket_state != 'ready'
    AND (
      (paymentSession.origin = 'current'
        AND (
          paymentSession.state = 'failed'
          OR (paymentSession.state IN ('completed', 'fully_refunded')
            AND paymentSession.completion_state = 'completed')
        ))
      OR
      (paymentSession.origin = 'legacy'
        AND paymentSession.state IN ('completed', 'failed', 'fully_refunded'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM payment_charges AS paymentCharge
       WHERE paymentCharge.payment_id = paymentSession.id
         AND (
           paymentCharge.origin = 'legacy'
           OR paymentCharge.updated_at >= ?
           OR paymentCharge.refund_state IN ('requested', 'pending', 'failed', 'unknown')
           OR paymentCharge.pending_refund_id IS NOT NULL
           OR paymentCharge.pending_refund_idempotency_key IS NOT NULL
         )
    )
    AND NOT EXISTS (
      SELECT 1 FROM payment_cases AS relatedCase
       WHERE relatedCase.payment_id = paymentSession.id
         AND (
           relatedCase.state != 'resolved'
           OR relatedCase.resolved_at IS NULL
           OR relatedCase.last_observed_at >= ?
           OR relatedCase.resolved_at >= ?
         )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM payment_case_decisions AS paymentDecision
        JOIN payment_cases AS decidedCase ON decidedCase.id = paymentDecision.case_id
       WHERE decidedCase.payment_id = paymentSession.id
         AND (
           paymentDecision.state != 'completed'
           OR paymentDecision.last_attempt_at IS NULL
           OR paymentDecision.last_attempt_at >= ?
         )
    )`,
});

import { encrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  executeBatchWithResults,
  queryAll,
  type SqlStatement,
} from "#shared/db/client.ts";
import {
  openNullablePaymentSessionJson,
  PAYMENT_STORAGE_CONTEXT,
  paymentStoredJson,
} from "#shared/db/payments/codecs.ts";
import type { LegacyPaymentRuntime } from "#shared/db/payments/legacy.ts";
import {
  type LegacyPaymentReplay,
  readLegacySession,
} from "#shared/db/payments/legacy-sessions.ts";
import { paymentRedactionEligibility } from "#shared/db/payments/redaction-eligibility.ts";
import {
  nextPaymentHistoryCheckpoint,
  PAYMENT_HISTORY_REDACTION_PAGE_SIZE,
  type PaymentHistoryRedactionCheckpoint,
} from "#shared/db/payments/redaction-page.ts";
import {
  redactBookingIntent,
  redactPaymentCaseEvidence,
  redactPaymentCompletion,
  redactPaymentResolution,
} from "#shared/db/payments/redaction-values.ts";
import { readStoredBookingIntent } from "#shared/db/payments/session-record.ts";
import { nowMs } from "#shared/now.ts";
import { legacyPaymentResult } from "#shared/payment-runtime/legacy-replay.ts";

export interface PaymentHistoryRedactionResult {
  checkpoint: PaymentHistoryRedactionCheckpoint;
  followUp: boolean;
  redacted: number;
}

interface CaseCandidate {
  evidence: EnvKeyEncrypted;
  id: number;
}

interface SessionCandidateBase {
  account_id: string | null;
  attendee_id: number | null;
  id: string;
  mode: string | null;
  result: EnvKeyEncrypted | null;
  revision: number;
  state: string;
  updated_at: number;
}

interface CurrentSessionCandidate extends SessionCandidateBase {
  booking_intent: EnvKeyEncrypted;
  completion: EnvKeyEncrypted | null;
  legacy_runtime: null;
  origin: "current";
  provider: string;
}

interface LegacySessionCandidate extends SessionCandidateBase {
  booking_intent: null;
  completion: null;
  legacy_runtime: EnvKeyEncrypted;
  origin: "legacy";
  provider: string | null;
}

type SessionCandidate = CurrentSessionCandidate | LegacySessionCandidate;

interface RedactedSession {
  bookingIntent: EnvKeyEncrypted | null;
  completion: EnvKeyEncrypted | null;
  legacyRuntime: EnvKeyEncrypted | null;
  result: EnvKeyEncrypted | null;
}

const caseCandidates = (
  cutoff: number,
  cursor: number | null,
): Promise<CaseCandidate[]> => {
  const eligible = paymentRedactionEligibility(cutoff);
  return queryAll<CaseCandidate>(
    `SELECT paymentCase.id, paymentCase.evidence
       FROM payment_cases AS paymentCase
       JOIN payment_sessions AS paymentSession
         ON paymentSession.id = paymentCase.payment_id
      WHERE paymentCase.state = 'resolved'
        AND paymentCase.evidence_redacted_at IS NULL
        AND paymentCase.id > ?
        AND ${eligible.sql}
      ORDER BY paymentCase.id
      LIMIT ?`,
    [cursor ?? 0, ...eligible.args, PAYMENT_HISTORY_REDACTION_PAGE_SIZE],
  );
};

const sessionCandidates = (
  cutoff: number,
  checkpoint: PaymentHistoryRedactionCheckpoint,
): Promise<SessionCandidate[]> => {
  const eligible = paymentRedactionEligibility(cutoff);
  const cursorAt = checkpoint.sessionUpdatedAt ?? -1;
  const cursorId = checkpoint.sessionId ?? "";
  return queryAll<SessionCandidate>(
    `SELECT paymentSession.id, paymentSession.origin, paymentSession.provider,
             paymentSession.mode, paymentSession.account_id, paymentSession.revision,
            paymentSession.state, paymentSession.updated_at,
            paymentSession.attendee_id, paymentSession.booking_intent,
            paymentSession.result, paymentSession.completion,
            paymentSession.legacy_runtime
       FROM payment_sessions AS paymentSession
      WHERE ${eligible.sql}
        AND NOT EXISTS (
          SELECT 1 FROM payment_cases AS unredactedCase
           WHERE unredactedCase.payment_id = paymentSession.id
             AND unredactedCase.evidence_redacted_at IS NULL
        )
        AND (paymentSession.updated_at > ?
          OR (paymentSession.updated_at = ? AND paymentSession.id > ?))
      ORDER BY paymentSession.updated_at, paymentSession.id
      LIMIT ?`,
    [
      ...eligible.args,
      cursorAt,
      cursorAt,
      cursorId,
      PAYMENT_HISTORY_REDACTION_PAGE_SIZE,
    ],
  );
};

const caseStatement = async (
  candidate: CaseCandidate,
  cutoff: number,
  redactedAt: number,
): Promise<SqlStatement> => {
  const evidence = await paymentStoredJson.caseEvidence.open(
    candidate.evidence,
    `payment_cases.evidence for ${candidate.id}`,
  );
  const redacted = await paymentStoredJson.caseEvidence.seal(
    redactPaymentCaseEvidence(evidence),
    PAYMENT_STORAGE_CONTEXT.caseEvidence,
  );
  const eligible = paymentRedactionEligibility(cutoff);
  return {
    args: [
      redacted,
      redactedAt,
      candidate.id,
      candidate.evidence,
      ...eligible.args,
    ],
    sql: `UPDATE payment_cases AS paymentCase
      SET evidence = ?, evidence_redacted_at = ?
      WHERE paymentCase.id = ? AND paymentCase.evidence = ?
        AND paymentCase.state = 'resolved'
        AND paymentCase.evidence_redacted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM payment_sessions AS paymentSession
           WHERE paymentSession.id = paymentCase.payment_id
             AND ${eligible.sql}
        )`,
  };
};

const legacyReplay = async (
  row: LegacySessionCandidate,
): Promise<{ replay: LegacyPaymentReplay; runtime: LegacyPaymentRuntime }> => {
  const replay = await readLegacySession(row);
  return { replay, runtime: replay.runtime };
};

const redactLegacySession = async (
  row: LegacySessionCandidate,
): Promise<RedactedSession> => {
  const { replay, runtime } = await legacyReplay(row);
  const processed = runtime.processedPayment;
  if (processed === null) {
    throw new Error(`Terminal legacy payment ${row.id} has no processed row`);
  }
  const result = await legacyPaymentResult(replay);
  const failure = result.success
    ? null
    : await encrypt(
        JSON.stringify({
          error: "This payment could not be completed.",
          ...(result.status === undefined ? {} : { status: result.status }),
        }),
      );
  const redactedRuntime: LegacyPaymentRuntime = {
    attendeePayment: null,
    checkoutStage: null,
    processedPayment: {
      ...processed,
      failureData: failure ?? "",
      paymentReference: "",
      ticketTokens: "",
    },
    sumupCheckout: null,
  };
  return {
    bookingIntent: null,
    completion: null,
    legacyRuntime: await paymentStoredJson.legacyRuntime.seal(
      redactedRuntime,
      "payment_sessions.legacy_runtime",
    ),
    result: failure,
  };
};

const redactCurrentSession = async (
  row: CurrentSessionCandidate,
): Promise<RedactedSession> => {
  const [intent, completion, result] = await Promise.all([
    readStoredBookingIntent(row),
    openNullablePaymentSessionJson(
      paymentStoredJson.completion,
      row.completion,
      "completion",
      row.id,
    ),
    openNullablePaymentSessionJson(
      paymentStoredJson.result,
      row.result,
      "result",
      row.id,
    ),
  ]);
  const redactedIntent = redactBookingIntent(intent);
  const redactedCompletion =
    completion === null ? null : redactPaymentCompletion(completion);
  return {
    bookingIntent: await paymentStoredJson.bookingIntent.seal(
      redactedIntent,
      PAYMENT_STORAGE_CONTEXT.bookingIntent,
    ),
    completion:
      redactedCompletion === null
        ? null
        : await paymentStoredJson.completion.seal(
            redactedCompletion,
            PAYMENT_STORAGE_CONTEXT.sessionCompletion,
          ),
    legacyRuntime: null,
    result:
      result === null
        ? null
        : await paymentStoredJson.result.seal(
            redactPaymentResolution(result),
            PAYMENT_STORAGE_CONTEXT.sessionResult,
          ),
  };
};

const sessionStatement = async (
  row: SessionCandidate,
  cutoff: number,
  redactedAt: number,
): Promise<SqlStatement> => {
  const payload =
    row.origin === "current"
      ? await redactCurrentSession(row)
      : await redactLegacySession(row);
  const eligible = paymentRedactionEligibility(cutoff);
  return {
    args: [
      payload.bookingIntent,
      payload.result,
      payload.completion,
      payload.legacyRuntime,
      redactedAt,
      row.id,
      row.booking_intent,
      row.result,
      row.completion,
      row.legacy_runtime,
      ...eligible.args,
    ],
    sql: `UPDATE payment_sessions AS paymentSession
      SET booking_intent = ?, checkout_create = NULL, result = ?, completion = ?,
          legacy_runtime = ?, redacted_at = ?
      WHERE paymentSession.id = ?
        AND paymentSession.booking_intent IS ?
        AND paymentSession.result IS ?
        AND paymentSession.completion IS ?
        AND paymentSession.legacy_runtime IS ?
        AND ${eligible.sql}
        AND NOT EXISTS (
          SELECT 1 FROM payment_cases AS unredactedCase
           WHERE unredactedCase.payment_id = paymentSession.id
             AND unredactedCase.evidence_redacted_at IS NULL
        )`,
  };
};

export const redactPaymentHistoryPage = async (
  checkpoint: PaymentHistoryRedactionCheckpoint,
  cutoff: number,
): Promise<PaymentHistoryRedactionResult> => {
  const [cases, sessions] = await Promise.all([
    caseCandidates(cutoff, checkpoint.caseId),
    sessionCandidates(cutoff, checkpoint),
  ]);
  const redactedAt = nowMs();
  const statements = await Promise.all([
    ...cases.map((candidate) => caseStatement(candidate, cutoff, redactedAt)),
    ...sessions.map((candidate) =>
      sessionStatement(candidate, cutoff, redactedAt),
    ),
  ]);
  if (statements.length > 0) {
    const deliveryCleanup = sessions.map(
      (session): SqlStatement => ({
        args: [session.id, session.id, redactedAt],
        sql: `DELETE FROM payment_completion_deliveries
             WHERE payment_id = ?
               AND EXISTS (
                 SELECT 1 FROM payment_sessions AS paymentSession
                  WHERE paymentSession.id = ?
                    AND paymentSession.redacted_at = ?
               )`,
      }),
    );
    const results = await executeBatchWithResults([
      ...statements,
      ...deliveryCleanup,
    ]);
    if (
      results
        .slice(0, statements.length)
        .some((result) => result.rowsAffected !== 1)
    ) {
      throw new Error("Payment history changed while it was being redacted");
    }
  }
  return {
    checkpoint: nextPaymentHistoryCheckpoint(cases, sessions),
    followUp:
      cases.length > 0 ||
      sessions.length === PAYMENT_HISTORY_REDACTION_PAGE_SIZE,
    redacted: statements.length,
  };
};

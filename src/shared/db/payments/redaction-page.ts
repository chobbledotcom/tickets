export const PAYMENT_HISTORY_REDACTION_PAGE_SIZE = 25;

export interface PaymentHistoryRedactionCheckpoint {
  caseId: number | null;
  sessionId: string | null;
  sessionUpdatedAt: number | null;
}

interface CaseCursorRow {
  id: number;
}

interface SessionCursorRow {
  id: string;
  updated_at: number;
}

const lastFullPageRow = <Row>(rows: readonly Row[]): Row | null =>
  rows.length === PAYMENT_HISTORY_REDACTION_PAGE_SIZE
    ? rows[rows.length - 1]!
    : null;

export const nextPaymentHistoryCheckpoint = (
  cases: readonly CaseCursorRow[],
  sessions: readonly SessionCursorRow[],
): PaymentHistoryRedactionCheckpoint => {
  const lastCase = lastFullPageRow(cases);
  const lastSession = cases.length === 0 ? lastFullPageRow(sessions) : null;
  return {
    caseId: lastCase === null ? null : lastCase.id,
    sessionId: lastSession === null ? null : lastSession.id,
    sessionUpdatedAt: lastSession === null ? null : lastSession.updated_at,
  };
};

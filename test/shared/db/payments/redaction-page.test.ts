import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  nextPaymentHistoryCheckpoint,
  PAYMENT_HISTORY_REDACTION_PAGE_SIZE,
} from "#shared/db/payments/redaction-page.ts";

const fullCases = Array.from(
  { length: PAYMENT_HISTORY_REDACTION_PAGE_SIZE },
  (_, index) => ({ id: index + 1 }),
);

const fullSessions = Array.from(
  { length: PAYMENT_HISTORY_REDACTION_PAGE_SIZE },
  (_, index) => ({ id: `session-${index + 1}`, updated_at: index + 100 }),
);

describe("payment redaction page", () => {
  test("advances a full case page", () => {
    expect(nextPaymentHistoryCheckpoint(fullCases, [])).toEqual({
      caseId: PAYMENT_HISTORY_REDACTION_PAGE_SIZE,
      sessionId: null,
      sessionUpdatedAt: null,
    });
  });

  test("advances a full session page", () => {
    expect(nextPaymentHistoryCheckpoint([], fullSessions)).toEqual({
      caseId: null,
      sessionId: `session-${PAYMENT_HISTORY_REDACTION_PAGE_SIZE}`,
      sessionUpdatedAt: PAYMENT_HISTORY_REDACTION_PAGE_SIZE + 99,
    });
  });

  test("clears a partial case page", () => {
    expect(nextPaymentHistoryCheckpoint(fullCases.slice(1), [])).toEqual({
      caseId: null,
      sessionId: null,
      sessionUpdatedAt: null,
    });
  });

  test("clears a partial session page", () => {
    expect(nextPaymentHistoryCheckpoint([], fullSessions.slice(1))).toEqual({
      caseId: null,
      sessionId: null,
      sessionUpdatedAt: null,
    });
  });

  test("restarts sessions after redacting a case", () => {
    expect(nextPaymentHistoryCheckpoint([{ id: 1 }], fullSessions)).toEqual({
      caseId: null,
      sessionId: null,
      sessionUpdatedAt: null,
    });
  });
});

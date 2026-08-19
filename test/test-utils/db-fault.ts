import { execute } from "#db/client.ts";

/**
 * Run `body` with one database fault installed — a trigger that makes a
 * chosen write fail at SQLite's own boundary — then lift the fault. Real
 * faults at the storage layer, not stubs: the failing statement rolls back
 * exactly as a production write would.
 */
export const withDbFault = async <T>(
  createTrigger: string,
  name: string,
  body: () => Promise<T>,
): Promise<T> => {
  await execute(createTrigger);
  try {
    return await body();
  } finally {
    await execute(`DROP TRIGGER IF EXISTS ${name}`);
  }
};

const RETIREMENT_FAULT = "test_authority_retirement_fault";

/** The authority retirement — the update that marks a completed refund's
 * local recording done — refuses, and every other write stays available. */
export const withAuthorityRetirementFault = <T>(
  body: () => Promise<T>,
): Promise<T> =>
  withDbFault(
    `CREATE TRIGGER ${RETIREMENT_FAULT}
      BEFORE UPDATE ON payment_charges
      WHEN NEW.refund_local_state = 'recorded'
      BEGIN
        SELECT RAISE(ABORT, 'authority retirement unavailable');
      END`,
    RETIREMENT_FAULT,
    body,
  );

const SESSION_FAILURE_FAULT = "test_session_failure_fault";

/** The write that records a session's terminal failure refuses, so a test
 * can die exactly between a refund going out and the answer landing. */
export const withSessionFailureFault = <T>(
  body: () => Promise<T>,
): Promise<T> =>
  withDbFault(
    `CREATE TRIGGER ${SESSION_FAILURE_FAULT}
      BEFORE UPDATE OF failure_data ON processed_payments
      WHEN NEW.failure_data != ''
      BEGIN
        SELECT RAISE(ABORT, 'session failure write refused');
      END`,
    SESSION_FAILURE_FAULT,
    body,
  );

const CONFIRMATION_FAULT = "test_refund_confirmation_fault";

/** The once-only confirmation latch refuses, so the note and activity line
 * that ride its transaction never land on this run. */
export const withRefundConfirmationFault = <T>(
  body: () => Promise<T>,
): Promise<T> =>
  withDbFault(
    `CREATE TRIGGER ${CONFIRMATION_FAULT}
      BEFORE INSERT ON refund_confirmations
      BEGIN
        SELECT RAISE(ABORT, 'refund confirmation unavailable');
      END`,
    CONFIRMATION_FAULT,
    body,
  );

import { decrypt } from "#shared/crypto/encryption.ts";
import { encryptWithOwnerKey } from "#shared/crypto/keys.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { execute, queryAll } from "#shared/db/client.ts";
import { paymentClaimRowsSql } from "#shared/db/payment-claim.ts";
import { settings } from "#shared/db/settings.ts";
import {
  assertJointStateLegal,
  authorityFactOf,
  jointRowFactOf,
} from "#shared/payment/joint-state.ts";
import { readRowState } from "#shared/payment/row-state.ts";

interface JointRow {
  attendee_id: number | null;
  failure_data: EnvKeyEncrypted | "";
  payment_session_id: string;
  refund_state_name: string | null;
}

/** The session's own row plus every row sharing its payment reference — a
 * placeholder keeps its pending outcome on the session row and its claim on
 * the anchor row, and both belong to the same crash picture. */
const SESSION_AND_SIBLINGS = `payment.payment_session_id = ?
   OR (payment.payment_reference_index != ''
       AND payment.payment_reference_index IN (
         SELECT sibling.payment_reference_index
           FROM processed_payments AS sibling
          WHERE sibling.payment_session_id = ?))`;

/** Store one payment row exactly as SQL sees it. The scan tests plant
 * combinations no production writer can make, so they write the mirror
 * columns directly instead of going through a flow. */
export const plantPaymentRow = async (
  sessionId: string,
  referenceIndex: string,
  protectedState: string,
): Promise<void> => {
  await execute(
    `INSERT INTO processed_payments
       (payment_session_id, processed_at, protected_state,
        payment_reference_index)
     VALUES (?, ?, ?, ?)`,
    [sessionId, "2026-08-17T10:00:00.000Z", protectedState, referenceIndex],
  );
};

/** Store one charge whose refund authority says a send may be out, shaped
 * to pass the table's own JSON-mirror and ciphertext checks without a
 * production writer. */
export const plantArmedCharge = async (
  referenceIndex: string,
): Promise<void> => {
  const state = JSON.stringify({
    kind: "send_armed",
    local: { kind: "not_due" },
    nextActionAt: 0,
    request: { capability: "keyless" },
  });
  await execute(
    `INSERT INTO payment_charges
       (provider, provider_reference, reference_index, capability,
        captured_amount, currency, refund_state, refund_state_name,
        refund_local_state, next_refund_action_at, created_at, updated_at,
        observed_at)
     VALUES ('stripe', ?, ?, 'keyless', 100, 'GBP', ?, 'send_armed',
             'not_due', 0, 0, 0, 0)`,
    [
      await encryptWithOwnerKey(referenceIndex, settings.publicKey),
      referenceIndex,
      state,
    ],
  );
};

/**
 * Load every stored machine one session touches and prove each row's
 * combination is one a flow can produce. Crash tests call this right after
 * manufacturing their crash, so every manufactured intermediate state also
 * witnesses the seam between the machines — a crash state the seam calls
 * impossible fails the test that made it.
 */
export const expectLegalJointStates = async (
  sessionId: string,
  context: string,
): Promise<void> => {
  const rows = await queryAll<JointRow>(
    paymentClaimRowsSql(SESSION_AND_SIBLINGS),
    [sessionId, sessionId],
  );
  if (rows.length === 0) {
    throw new Error(`No payment rows to witness for ${context}`);
  }
  for (const [id, group] of Map.groupBy(
    rows,
    (row) => row.payment_session_id,
  )) {
    const first = group[0]!;
    const state =
      first.failure_data === ""
        ? {}
        : readRowState(
            await decrypt(first.failure_data),
            "processed_payments.failure_data",
          );
    assertJointStateLegal(
      jointRowFactOf(state, first.attendee_id !== null),
      group.map((row) => authorityFactOf(row.refund_state_name)),
      `${context} (row ${id})`,
    );
  }
};

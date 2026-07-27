/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { identity, mapById } from "#fp";
import {
  execute,
  inPlaceholders,
  queryAll,
  queryBatchPrimary,
  queryOne,
  queryOnePrimary,
  resultRows,
} from "#shared/db/client.ts";
import {
  PAYMENT_STORAGE_CONTEXT,
  paymentStoredJson,
} from "#shared/db/payments/codecs.ts";
import {
  PAYMENT_SESSION_COLUMNS,
  readPaymentSessionRow,
  readPaymentSessionRows,
  type StoredPaymentSessionRow,
  storeBookingIntent,
  storeCheckoutCreate,
  storedSessionOutcomeValues,
  storeSessionProgress,
} from "#shared/db/payments/session-record.ts";
import {
  type PaymentSession,
  type PaymentSessionCreate,
  PaymentSessionCreateSchema,
  parsePaymentSessionProgress,
} from "#shared/db/payments/types.ts";
import { nowMs } from "#shared/now.ts";
import type { ProviderSessionResource } from "#shared/payment-state/resources.ts";

/* jscpd:ignore-end */

const columnsSql = PAYMENT_SESSION_COLUMNS.join(", ");

const insertPaymentSession = async (
  inputValue: PaymentSessionCreate,
  createdAt: number,
  orIgnore: boolean,
): Promise<PaymentSession | null> => {
  const input = v.parse(PaymentSessionCreateSchema, inputValue);
  const initial = parsePaymentSessionProgress({
    attendeeId: null,
    completion: null,
    completionState: "none",
    nextReconcileAt: input.checkoutCreate === null ? null : createdAt + 60_000,
    result: null,
    resultState: "none",
    session: input.session,
    state: "created",
    ticketState: "none",
    ticketTokens: null,
  });
  const [progress, bookingIntent, checkoutCreate] = await Promise.all([
    storeSessionProgress(initial),
    storeBookingIntent(input.bookingIntent),
    storeCheckoutCreate(input.checkoutCreate),
  ]);
  const result = await execute(
    `INSERT ${orIgnore ? "OR IGNORE " : ""}INTO payment_sessions
      (id, origin, provider, mode, account_id, session_resource,
       session_reference_index, expected_amount, expected_currency,
        booking_intent, checkout_create, state, revision, created_at, updated_at,
       next_reconcile_at, attendee_id, result_state, result, ticket_state,
       ticket_tokens, completion_state, completion, legacy_runtime)
       VALUES (
         ?, 'current', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         NULL
       )`,
    [
      input.id,
      input.provider,
      input.mode,
      input.accountId,
      progress.sessionResource,
      progress.sessionReferenceIndex,
      input.expected.amount,
      input.expected.currency,
      bookingIntent,
      checkoutCreate,
      progress.state,
      createdAt,
      createdAt,
      progress.nextReconcileAt,
      ...storedSessionOutcomeValues(progress),
    ],
  );
  if (result.rowsAffected === 0) return null;
  return {
    ...initial,
    accountId: input.accountId,
    bookingIntent: input.bookingIntent,
    checkoutCreate: input.checkoutCreate,
    createdAt,
    expected: input.expected,
    id: input.id,
    leaseExpiresAt: null,
    mode: input.mode,
    provider: input.provider,
    revision: 1,
    updatedAt: createdAt,
  };
};

export const createPaymentSession = async (
  input: PaymentSessionCreate,
  createdAt = nowMs(),
): Promise<PaymentSession> => {
  const payment = await insertPaymentSession(input, createdAt, false);
  if (payment === null) {
    throw new Error(`Payment session ${input.id} was not created`);
  }
  return payment;
};

/** Adopt one signed pre-aggregate checkout exactly once by provider resource. */
export const adoptPaymentSession = async (
  input: PaymentSessionCreate & { session: ProviderSessionResource },
  createdAt = nowMs(),
): Promise<PaymentSession> => {
  const created = await insertPaymentSession(input, createdAt, true);
  if (created !== null) return created;
  const existing = await getPaymentSessionByResourceOrNullPrimary(
    input.session,
  );
  if (existing === null) {
    throw new Error(`Payment session ${input.id} could not be adopted`);
  }
  return existing;
};

type GetPaymentSessions = (
  ids: readonly string[],
) => Promise<(PaymentSession | null)[]>;

/** Build an ordered payment reader for replica or primary reads. */
const paymentSessionsFrom =
  (primary: boolean): GetPaymentSessions =>
  async (ids) => {
    if (ids.length === 0) return [];
    const statement = {
      args: [...ids],
      sql: `SELECT ${columnsSql}
       FROM payment_sessions
       WHERE origin = 'current' AND id IN (${inPlaceholders(ids)})`,
    };
    const rows = primary
      ? resultRows<StoredPaymentSessionRow>(
          (await queryBatchPrimary([statement]))[0]!,
        )
      : await queryAll<StoredPaymentSessionRow>(statement.sql, statement.args);
    const sessions = await readPaymentSessionRows(rows);
    const byId = mapById(identity<PaymentSession>)(sessions);
    return ids.map((id) => {
      const session = byId.get(id);
      return session === undefined ? null : session;
    });
  };

/** Read current payment sessions through a replica-capable query. */
export const getPaymentSessions: GetPaymentSessions =
  paymentSessionsFrom(false);

/** Read current payment sessions from the primary after provider or local IO. */
export const getPaymentSessionsPrimary: GetPaymentSessions =
  paymentSessionsFrom(true);

type GetPaymentSessionByResource = (
  resource: ProviderSessionResource,
) => Promise<PaymentSession | null>;

/** Build a provider-resource reader for replica or primary reads. */
const paymentSessionByResourceFrom =
  (primary: boolean): GetPaymentSessionByResource =>
  async (resource) => {
    const referenceIndex = await paymentStoredJson.sessionResource.index(
      resource,
      PAYMENT_STORAGE_CONTEXT.sessionLookup,
    );
    const sql = `SELECT ${columnsSql}
       FROM payment_sessions
       WHERE origin = 'current' AND session_reference_index = ?
       LIMIT 1`;
    const row = primary
      ? await queryOnePrimary<StoredPaymentSessionRow>(sql, [referenceIndex])
      : await queryOne<StoredPaymentSessionRow>(sql, [referenceIndex]);
    return row === null ? null : await readPaymentSessionRow(row);
  };

/** Find a current payment by provider resource through a replica-capable read. */
export const getPaymentSessionByResourceOrNull: GetPaymentSessionByResource =
  paymentSessionByResourceFrom(false);

/** Find a current payment by provider resource on the primary. */
export const getPaymentSessionByResourceOrNullPrimary: GetPaymentSessionByResource =
  paymentSessionByResourceFrom(true);

/** Load current aggregate payments for the requested attendees. */
export const getPaymentSessionsByAttendeeIds = async (
  attendeeIds: readonly number[],
): Promise<PaymentSession[]> => {
  if (attendeeIds.length === 0) return [];
  return readPaymentSessionRows(
    await queryAll<StoredPaymentSessionRow>(
      `SELECT ${columnsSql}
         FROM payment_sessions
        WHERE origin = 'current'
          AND attendee_id IN (${inPlaceholders(attendeeIds)})
        ORDER BY created_at, id`,
      [...attendeeIds],
    ),
  );
};

export const getAttendeeIdsWithPayments = async (
  attendees: readonly { id: number }[],
): Promise<Set<number>> => {
  if (attendees.length === 0) return new Set();
  const rows = await queryAll<{ attendee_id: number }>(
    `SELECT DISTINCT paymentSession.attendee_id
       FROM payment_sessions AS paymentSession
      WHERE paymentSession.attendee_id IN (${inPlaceholders(attendees)})
        AND EXISTS (
          SELECT 1 FROM payment_charges AS paymentCharge
           WHERE paymentCharge.payment_id = paymentSession.id
        )`,
    attendees.map((attendee) => attendee.id),
  );
  return new Set(rows.map((row) => Number(row.attendee_id)));
};

/** Consume the aggregate's callback copy of ticket tokens once. The attendee's
 * ticket token remains valid, so the returned first redirect and wallet links
 * keep working while old payment PII can later be redacted. */
export const consumePaymentTicketTokens = async (
  paymentId: string,
): Promise<boolean> => {
  const result = await execute(
    `UPDATE payment_sessions
             SET ticket_state = 'consumed',
                 ticket_tokens = NULL,
                 revision = revision + 1
           WHERE id = ? AND origin = 'current' AND ticket_state = 'ready'`,
    [paymentId],
  );
  return result.rowsAffected === 1;
};

export const attendeeHasPayment = async (attendee: {
  id: number;
}): Promise<boolean> =>
  (await getAttendeeIdsWithPayments([attendee])).has(attendee.id);

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import { mapParallel } from "#fp";
import type { BlindIndex, EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import type { SqlStatement } from "#shared/db/client.ts";
import {
  PAYMENT_STORAGE_CONTEXT,
  paymentStoredJson,
} from "#shared/db/payments/codecs.ts";
import {
  PaymentCompletionStateSchema,
  PaymentResultStateSchema,
  type PaymentSession,
  type PaymentSessionProgress,
  PaymentTicketStateSchema,
  parsePaymentSessionProgress,
  StoredPaymentIntegerSchema,
} from "#shared/db/payments/types.ts";
import { PaymentSessionStateSchema } from "#shared/payment-state/lifecycle.ts";
import { PaymentModeSchema } from "#shared/payment-state/observation.ts";
import { MoneySchema } from "#shared/payment-state/resources.ts";
import { sameJson } from "#shared/same-json.ts";
import { PaymentProviderSchema } from "#shared/types.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

/* jscpd:ignore-end */

export const PAYMENT_SESSION_COLUMNS = [
  "id",
  "provider",
  "mode",
  "account_id",
  "session_resource",
  "session_reference_index",
  "expected_amount",
  "expected_currency",
  "booking_intent",
  "checkout_create",
  "state",
  "revision",
  "created_at",
  "updated_at",
  "lease_expires_at",
  "next_reconcile_at",
  "attendee_id",
  "result_state",
  "result",
  "ticket_state",
  "ticket_tokens",
  "completion_state",
  "completion",
] as const;

export interface StoredPaymentSessionRow {
  account_id: string;
  attendee_id: number | null;
  booking_intent: EnvKeyEncrypted;
  checkout_create: EnvKeyEncrypted | null;
  completion: EnvKeyEncrypted | null;
  completion_state: v.InferOutput<typeof PaymentCompletionStateSchema>;
  created_at: number;
  expected_amount: number;
  expected_currency: string;
  id: string;
  lease_expires_at: number | null;
  mode: v.InferOutput<typeof PaymentModeSchema>;
  next_reconcile_at: number | null;
  provider: v.InferOutput<typeof PaymentProviderSchema>;
  result: EnvKeyEncrypted | null;
  result_state: v.InferOutput<typeof PaymentResultStateSchema>;
  revision: number;
  session_reference_index: BlindIndex | null;
  session_resource: EnvKeyEncrypted | null;
  state: v.InferOutput<typeof PaymentSessionStateSchema>;
  ticket_state: v.InferOutput<typeof PaymentTicketStateSchema>;
  ticket_tokens: EnvKeyEncrypted | null;
  updated_at: number;
}

const StoredPaymentSessionRowSchema = v.strictObject({
  account_id: v.string(),
  attendee_id: v.nullable(StoredPaymentIntegerSchema),
  booking_intent: v.string(),
  checkout_create: v.nullable(v.string()),
  completion: v.nullable(v.string()),
  completion_state: PaymentCompletionStateSchema,
  created_at: integerAtLeast(0),
  expected_amount: integerAtLeast(0),
  expected_currency: v.string(),
  id: v.string(),
  lease_expires_at: v.nullable(integerAtLeast(0)),
  mode: PaymentModeSchema,
  next_reconcile_at: v.nullable(integerAtLeast(0)),
  provider: PaymentProviderSchema,
  result: v.nullable(v.string()),
  result_state: PaymentResultStateSchema,
  revision: integerAtLeast(1),
  session_reference_index: v.nullable(v.string()),
  session_resource: v.nullable(v.string()),
  state: PaymentSessionStateSchema,
  ticket_state: PaymentTicketStateSchema,
  ticket_tokens: v.nullable(v.string()),
  updated_at: integerAtLeast(0),
});

export interface StoredSessionProgress {
  attendeeId: number | null;
  completion: EnvKeyEncrypted | null;
  completionState: v.InferOutput<typeof PaymentCompletionStateSchema>;
  nextReconcileAt: number | null;
  result: EnvKeyEncrypted | null;
  resultState: v.InferOutput<typeof PaymentResultStateSchema>;
  sessionReferenceIndex: BlindIndex | null;
  sessionResource: EnvKeyEncrypted | null;
  state: v.InferOutput<typeof PaymentSessionStateSchema>;
  ticketState: v.InferOutput<typeof PaymentTicketStateSchema>;
  ticketTokens: EnvKeyEncrypted | null;
}

export const storedSessionOutcomeValues = (
  progress: StoredSessionProgress,
): SqlStatement["args"] => [
  progress.attendeeId,
  progress.resultState,
  progress.result,
  progress.ticketState,
  progress.ticketTokens,
  progress.completionState,
  progress.completion,
];

export const storeSessionProgress = async (
  progressValue: PaymentSessionProgress,
): Promise<StoredSessionProgress> => {
  const progress = parsePaymentSessionProgress(progressValue);
  const [session, result, ticketTokens, completion] = await Promise.all([
    progress.session === null
      ? null
      : paymentStoredJson.sessionResource.sealIndexed(
          progress.session,
          PAYMENT_STORAGE_CONTEXT.sessionResource,
        ),
    progress.result === null
      ? null
      : paymentStoredJson.result.seal(
          progress.result,
          PAYMENT_STORAGE_CONTEXT.sessionResult,
        ),
    progress.ticketTokens === null
      ? null
      : paymentStoredJson.ticketTokens.seal(
          progress.ticketTokens,
          PAYMENT_STORAGE_CONTEXT.sessionTicketTokens,
        ),
    progress.completion === null
      ? null
      : paymentStoredJson.completion.seal(
          progress.completion,
          PAYMENT_STORAGE_CONTEXT.sessionCompletion,
        ),
  ]);
  return {
    attendeeId: progress.attendeeId,
    completion,
    completionState: progress.completionState,
    nextReconcileAt: progress.nextReconcileAt,
    result,
    resultState: progress.resultState,
    sessionReferenceIndex: session === null ? null : session.index,
    sessionResource: session === null ? null : session.ciphertext,
    state: progress.state,
    ticketState: progress.ticketState,
    ticketTokens,
  };
};

export const storeBookingIntent = (
  intent: PaymentSession["bookingIntent"],
): Promise<EnvKeyEncrypted> =>
  paymentStoredJson.bookingIntent.seal(
    intent,
    PAYMENT_STORAGE_CONTEXT.bookingIntent,
  );

export const storeCheckoutCreate = (
  checkout: PaymentSession["checkoutCreate"],
): Promise<EnvKeyEncrypted | null> =>
  checkout === null
    ? Promise.resolve(null)
    : paymentStoredJson.checkoutCreate.seal(
        checkout,
        PAYMENT_STORAGE_CONTEXT.sessionCheckoutCreate,
      );

export const readStoredBookingIntent = (
  row: Pick<StoredPaymentSessionRow, "booking_intent" | "id">,
): Promise<PaymentSession["bookingIntent"]> =>
  paymentStoredJson.bookingIntent.open(
    row.booking_intent,
    `payment_sessions.booking_intent for ${row.id}`,
  );

export const readPaymentSessionRow = async (
  row: StoredPaymentSessionRow,
): Promise<PaymentSession> => {
  v.parse(StoredPaymentSessionRowSchema, row);
  const [
    bookingIntent,
    checkoutCreate,
    session,
    result,
    ticketTokens,
    completion,
  ] = await Promise.all([
    readStoredBookingIntent(row),
    row.checkout_create === null
      ? null
      : paymentStoredJson.checkoutCreate.open(
          row.checkout_create,
          `payment_sessions.checkout_create for ${row.id}`,
        ),
    row.session_resource === null
      ? null
      : paymentStoredJson.sessionResource.open(
          row.session_resource,
          `payment_sessions.session_resource for ${row.id}`,
        ),
    row.result === null
      ? null
      : paymentStoredJson.result.open(
          row.result,
          `payment_sessions.result for ${row.id}`,
        ),
    row.ticket_tokens === null
      ? null
      : paymentStoredJson.ticketTokens.open(
          row.ticket_tokens,
          `payment_sessions.ticket_tokens for ${row.id}`,
        ),
    row.completion === null
      ? null
      : paymentStoredJson.completion.open(
          row.completion,
          `payment_sessions.completion for ${row.id}`,
        ),
  ]);
  const progress = parsePaymentSessionProgress({
    attendeeId: row.attendee_id,
    completion,
    completionState: row.completion_state,
    nextReconcileAt: row.next_reconcile_at,
    result,
    resultState: row.result_state,
    session,
    state: row.state,
    ticketState: row.ticket_state,
    ticketTokens,
  });
  if (completion !== null && !sameJson(completion.input, bookingIntent)) {
    throw new Error(
      `Payment completion input differs from booking intent for ${row.id}`,
    );
  }
  if (session !== null && session.provider !== row.provider) {
    throw new Error(
      `Invalid stored provider resource in payment_sessions.session_resource for ${row.id}`,
    );
  }
  return {
    ...progress,
    accountId: row.account_id,
    bookingIntent,
    checkoutCreate,
    createdAt: row.created_at,
    expected: v.parse(MoneySchema, {
      amount: row.expected_amount,
      currency: row.expected_currency,
    }),
    id: row.id,
    leaseExpiresAt: row.lease_expires_at,
    mode: row.mode,
    provider: row.provider,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
};

export const readPaymentSessionRows = (
  rows: StoredPaymentSessionRow[],
): Promise<PaymentSession[]> => mapParallel(readPaymentSessionRow)(rows);

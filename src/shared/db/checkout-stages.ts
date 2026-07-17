/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import * as v from "valibot";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { execute, queryOne, queryOnePrimary } from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";
import {
  PaymentProviderSchema,
  type PaymentProviderType,
} from "#shared/types.ts";
/* jscpd:ignore-end */

export const CheckoutStageStateSchema = v.picklist(["pending", "refunding"]);
export type CheckoutStageState = v.InferOutput<typeof CheckoutStageStateSchema>;

const CheckoutStageRowSchema = v.object({
  attendee_id: v.number(),
  created_at: v.string(),
  payment_session_id: v.string(),
  provider: PaymentProviderSchema,
  provider_checkout_id: v.string(),
  state: CheckoutStageStateSchema,
  ticket_tokens: v.string(),
});

export type CheckoutStage = {
  attendeeId: number;
  createdAt: string;
  paymentSessionId: string;
  provider: PaymentProviderType;
  providerCheckoutId: string;
  state: CheckoutStageState;
  ticketToken: string;
};

export type PendingCheckoutStage = {
  paymentSessionId: string;
  provider: PaymentProviderType;
  providerCheckoutId: string;
};

const checkoutStage = (
  row: v.InferOutput<typeof CheckoutStageRowSchema>,
  ticketToken: string,
): CheckoutStage => ({
  attendeeId: row.attendee_id,
  createdAt: row.created_at,
  paymentSessionId: row.payment_session_id,
  provider: row.provider,
  providerCheckoutId: row.provider_checkout_id,
  state: row.state,
  ticketToken,
});

export const pendingCheckoutStageInsert = async (
  stage: PendingCheckoutStage,
  attendeeIdSql: string,
  attendeeIdArgs: InValue[],
  ticketToken: string,
): Promise<{ sql: string; args: InValue[] }> => ({
  args: [
    stage.paymentSessionId,
    ...attendeeIdArgs,
    stage.provider,
    stage.providerCheckoutId,
    await encrypt(ticketToken),
    "pending",
    nowIso(),
  ],
  sql: `INSERT INTO checkout_stages
          (payment_session_id, attendee_id, provider, provider_checkout_id, ticket_tokens, state, created_at)
        VALUES (?, ${attendeeIdSql}, ?, ?, ?, ?, ?)`,
});

/** Find one stage only when the session, attendee, and plaintext token all match. */
export const findCheckoutStage = async (
  paymentSessionId: string,
  attendeeId: number,
  ticketToken: string,
): Promise<CheckoutStage | null> => {
  const raw = await queryOne<unknown>(
    `SELECT payment_session_id, attendee_id, provider, provider_checkout_id,
            ticket_tokens, state, created_at
       FROM checkout_stages
      WHERE payment_session_id = ? AND attendee_id = ?`,
    [paymentSessionId, attendeeId],
  );
  if (raw === null) return null;
  const row = v.parse(CheckoutStageRowSchema, raw);
  if ((await decrypt(row.ticket_tokens as EnvKeyEncrypted)) !== ticketToken) {
    return null;
  }
  return checkoutStage(row, ticketToken);
};

const checkoutStageFromRow = async (raw: unknown): Promise<CheckoutStage> => {
  const row = v.parse(CheckoutStageRowSchema, raw);
  return checkoutStage(
    row,
    await decrypt(row.ticket_tokens as EnvKeyEncrypted),
  );
};

/** Load an open checkout stage from the primary by its payment session. */
export const loadCheckoutStageByPaymentSession = async (
  paymentSessionId: string,
): Promise<CheckoutStage | null> => {
  const row = await queryOnePrimary<unknown>(
    `SELECT payment_session_id, attendee_id, provider, provider_checkout_id,
            ticket_tokens, state, created_at
       FROM checkout_stages WHERE payment_session_id = ?`,
    [paymentSessionId],
  );
  return row === null ? null : checkoutStageFromRow(row);
};

/** Permanently route a pending stage toward refunding instead of activation. */
const beginCheckoutStageRefund = async (
  paymentSessionId: string,
): Promise<void> => {
  const result = await execute(
    `UPDATE checkout_stages SET state = 'refunding'
      WHERE payment_session_id = ? AND state = 'pending'`,
    [paymentSessionId],
  );
  if (result.rowsAffected !== 1) {
    throw new Error(
      `Checkout stage ${paymentSessionId} did not enter refunding`,
    );
  }
};

export const checkoutStagesApi = {
  beginRefund: beginCheckoutStageRefund,
  find: findCheckoutStage,
  loadByPaymentSession: loadCheckoutStageByPaymentSession,
};

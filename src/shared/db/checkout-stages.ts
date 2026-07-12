import type { InValue } from "@libsql/client";
import * as v from "valibot";
import { unique } from "#fp";
import { orderBookings } from "#shared/booking-lines.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { generateTicketToken } from "#shared/crypto/utils.ts";
import { getPublicStatusId } from "#shared/db/attendee-statuses.ts";
import { createAttendeeAtomic } from "#shared/db/attendees/api.ts";
import {
  execute,
  executeBatchWithResults,
  insert,
  queryOnePrimary,
  type TxScope,
} from "#shared/db/client.ts";
import { getListingsWithCountsByIds } from "#shared/db/listings.ts";
import {
  decryptSessionTokens,
  encryptTicketTokens,
} from "#shared/db/processed-payments.ts";
import { nowIso } from "#shared/now.ts";
import { toBookingItems } from "#shared/payment-helpers.ts";
import type {
  CheckoutIntent,
  PaymentProvider,
  PaymentProviderType,
} from "#shared/payments.ts";

const CheckoutStageStateSchema = v.picklist(["pending", "booked", "failed"]);
export type CheckoutStageState = v.InferOutput<typeof CheckoutStageStateSchema>;

type CheckoutStageRow = {
  attendee_id: number;
  provider: PaymentProviderType;
  state: CheckoutStageState;
  ticket_tokens: EnvKeyEncrypted;
};

export type CheckoutStage = {
  attendeeId: number;
  provider: PaymentProviderType;
  state: CheckoutStageState;
  ticketToken: string;
};

const stagedBookings = async (intent: CheckoutIntent) => {
  const items = toBookingItems(intent);
  const listings = await getListingsWithCountsByIds(
    unique(items.map((item) => item.e)),
  );
  const listingById = new Map(listings.map((listing) => [listing.id, listing]));
  const lines = items.map((item) => {
    const listing = listingById.get(item.e);
    if (!listing) throw new Error(`Listing ${item.e} vanished before checkout`);
    return { item, listing };
  });
  return orderBookings(lines, { ...intent, items }).map((booking) => ({
    ...booking,
    quantity: 0,
  }));
};

const stageInsert = async (
  tx: TxScope,
  sessionId: string,
  attendeeId: number,
  provider: PaymentProviderType,
  ticketToken: string,
): Promise<void> => {
  await tx.execute(
    insert("checkout_stages", {
      attendee_id: attendeeId,
      created_at: nowIso(),
      payment_session_id: sessionId,
      provider,
      state: "pending",
      ticket_tokens: await encryptTicketTokens([ticketToken]),
    }),
  );
};

/** Save a fresh checkout as one attendee with exact quantity-zero path rows. */
export const stageCheckout = async (
  sessionId: string,
  provider: PaymentProviderType,
  intent: CheckoutIntent,
): Promise<CheckoutStage> => {
  const ticketToken = generateTicketToken();
  const result = await createAttendeeAtomic(
    {
      address: intent.address,
      bookings: await stagedBookings(intent),
      email: intent.email,
      name: intent.name,
      phone: intent.phone,
      source: "public",
      special_instructions: intent.special_instructions,
      statusId: await getPublicStatusId(),
      ticketToken,
    },
    (tx, attendeeId) =>
      stageInsert(tx, sessionId, attendeeId, provider, ticketToken),
  );
  if (!result.success) {
    throw new Error(`Could not stage checkout: ${result.reason}`);
  }
  return {
    attendeeId: result.attendees[0]!.id,
    provider,
    state: "pending",
    ticketToken,
  };
};

/** Create the provider session, then stage it before exposing the checkout URL. */
export const createStagedCheckout = async (
  provider: PaymentProvider,
  intent: CheckoutIntent,
  baseUrl: string,
) => {
  const result = await provider.createCheckoutSession(intent, baseUrl);
  if (!result || "error" in result || intent.balanceAttendeeId !== undefined) {
    return result;
  }
  await stageCheckout(result.sessionId, provider.type, intent);
  return result;
};

export const getCheckoutStage = async (
  sessionId: string,
): Promise<CheckoutStage | null> => {
  const row = await queryOnePrimary<CheckoutStageRow>(
    `SELECT attendee_id, provider, state, ticket_tokens
     FROM checkout_stages WHERE payment_session_id = ?`,
    [sessionId],
  );
  if (!row) return null;
  const parsedState = v.parse(CheckoutStageStateSchema, row.state);
  const ticketToken = await decryptSessionTokens(row.ticket_tokens);
  if (!ticketToken) throw new Error(`Checkout stage ${sessionId} has no token`);
  return {
    attendeeId: row.attendee_id,
    provider: row.provider,
    state: parsedState,
    ticketToken,
  };
};

export const markCheckoutStage = async (
  sessionId: string,
  state: CheckoutStageState,
): Promise<void> => {
  await execute(
    "UPDATE checkout_stages SET state = ? WHERE payment_session_id = ?",
    [state, sessionId],
  );
};

const pendingStageAttendees = (where: string): string =>
  `SELECT stage.attendee_id
     FROM checkout_stages AS stage
    WHERE stage.state = 'pending'
      AND ${where}
      AND NOT EXISTS (
        SELECT 1
          FROM processed_payments AS payment
         WHERE payment.payment_session_id = stage.payment_session_id
      )`;

/** Delete pending checkout PII only while no payment request has claimed it. */
const discardPendingCheckoutsWhere = async (
  where: string,
  args: InValue[],
): Promise<number> => {
  const attendeeIds = pendingStageAttendees(where);
  const attendeeDelete = (table: string) => ({
    args,
    sql: `DELETE FROM ${table} WHERE attendee_id IN (${attendeeIds})`,
  });
  const results = await executeBatchWithResults([
    attendeeDelete("attendee_answers"),
    attendeeDelete("listing_attendees"),
    attendeeDelete("system_notes"),
    {
      args,
      sql: `DELETE FROM attendees WHERE id IN (${attendeeIds})`,
    },
    {
      args,
      sql: `DELETE FROM checkout_stages AS stage
             WHERE stage.state = 'pending'
               AND ${where}
               AND NOT EXISTS (
                 SELECT 1
                   FROM processed_payments AS payment
                  WHERE payment.payment_session_id = stage.payment_session_id
               )`,
    },
  ]);
  return results[results.length - 1]!.rowsAffected;
};

/** Discard one or more cancelled sessions through the same atomic path. */
export const discardPendingCheckoutSessions = (
  sessionIds: string[],
): Promise<number> =>
  sessionIds.length === 0
    ? Promise.resolve(0)
    : discardPendingCheckoutsWhere(
        `stage.payment_session_id IN (${sessionIds.map(() => "?").join(", ")})`,
        sessionIds,
      );

/** Remove abandoned pending checkouts older than the retention cutoff. */
export const prunePendingCheckoutStages = (
  cutoffIso: string,
): Promise<number> =>
  discardPendingCheckoutsWhere("stage.created_at < ?", [cutoffIso]);

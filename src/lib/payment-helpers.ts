/**
 * Shared helpers for payment provider implementations.
 * Eliminates duplication between stripe.ts/square.ts and their provider adapters.
 */

import { map } from "#fp";
import type { ErrorCodeType, LogCategory } from "#lib/logger.ts";
import { logDebug, logError } from "#lib/logger.ts";
import type {
  CheckoutSessionResult,
  MultiRegistrationIntent,
  SessionMetadata,
  ValidatedPaymentSession,
} from "#lib/payments.ts";

/** Safely execute async operation, returning null on error */
export const safeAsync = async <T>(
  fn: () => Promise<T>,
  errorCode: ErrorCodeType,
): Promise<T | null> => {
  try {
    return await fn();
  } catch (err) {
    const detail = err instanceof Error ? err.message : "unknown";
    logError({ code: errorCode, detail });
    return null;
  }
};

/**
 * Create a withClient helper that runs an operation with a lazily-resolved client.
 * Returns null if the client is not available or the operation fails.
 */
export const createWithClient = <Client>(
  getClient: () => Promise<Client | null>,
) =>
  async <T>(
    op: (client: Client) => Promise<T>,
    errorCode: ErrorCodeType,
  ): Promise<T | null> => {
    const client = await getClient();
    return client ? safeAsync(() => op(client), errorCode) : null;
  };

/** Serialize multi-ticket items for metadata storage (compact JSON) */
export const serializeMultiItems = (
  items: MultiRegistrationIntent["items"],
): string =>
  JSON.stringify(
    map((i: MultiRegistrationIntent["items"][number]) => ({
      e: i.eventId,
      q: i.quantity,
    }))(items),
  );

/**
 * Build intent metadata for a single-event checkout.
 * Common fields: event_id, name, email, quantity, optional phone.
 */
export const buildSingleIntentMetadata = (
  eventId: number,
  intent: { name: string; email: string; phone?: string | null; quantity: number },
): Record<string, string> => ({
  event_id: String(eventId),
  name: intent.name,
  email: intent.email,
  quantity: String(intent.quantity),
  ...(intent.phone ? { phone: intent.phone } : {}),
});

/**
 * Build intent metadata for a multi-event checkout.
 * Common fields: multi flag, name, email, serialized items, optional phone.
 */
export const buildMultiIntentMetadata = (
  intent: MultiRegistrationIntent,
): Record<string, string> => ({
  multi: "1",
  name: intent.name,
  email: intent.email,
  items: serializeMultiItems(intent.items),
  ...(intent.phone ? { phone: intent.phone } : {}),
});

/**
 * Convert a provider-specific checkout result to a CheckoutSessionResult.
 * Returns null if session ID or URL is missing.
 */
export const toCheckoutResult = (
  sessionId: string | undefined,
  url: string | undefined | null,
  label: LogCategory,
): CheckoutSessionResult => {
  if (!sessionId || !url) {
    logDebug(label, "Checkout result missing session ID or URL");
    return null;
  }
  return { sessionId, checkoutUrl: url };
};

/**
 * Validate that session metadata contains required fields (name, email)
 * and either event_id (single) or multi+items (multi).
 * Returns false if validation fails.
 */
export const hasRequiredSessionMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): metadata is SessionMetadata & { name: string; email: string } => {
  if (!metadata?.name || !metadata?.email) return false;
  const isMulti = metadata.multi === "1" && typeof metadata.items === "string";
  return isMulti || !!metadata.event_id;
};

/**
 * Extract the standard metadata fields from a provider-specific metadata object.
 * Assumes metadata has already been validated with hasRequiredSessionMetadata.
 */
export const extractSessionMetadata = (
  metadata: Record<string, string | undefined>,
): ValidatedPaymentSession["metadata"] => ({
  event_id: metadata.event_id,
  name: metadata.name!,
  email: metadata.email!,
  phone: metadata.phone,
  quantity: metadata.quantity,
  multi: metadata.multi,
  items: metadata.items,
});

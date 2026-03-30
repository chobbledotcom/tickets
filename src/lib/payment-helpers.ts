/**
 * Shared helpers for payment provider implementations.
 * Eliminates duplication between stripe.ts/square.ts and their provider adapters.
 */

import { map } from "#fp";
import { getEffectiveDomain } from "#lib/config.ts";
import type { ErrorCodeType, LogCategory } from "#lib/logger.ts";
import { logDebug, logError } from "#lib/logger.ts";
import type {
  BookingItem,
  CheckoutSessionResult,
  CartIntent,
  RegistrationIntent,
  SessionMetadata,
  ValidatedPaymentSession,
} from "#lib/payments.ts";
import type { ContactInfo } from "#lib/types.ts";

/** Extract a human-readable message from an unknown caught value */
export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : "Unknown error";

/** Error subclass for user-facing payment validation errors (e.g. invalid phone number).
 * These propagate through safeAsync so the message can be shown to the user. */
export class PaymentUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentUserError";
  }
}

/** Safely execute async operation, returning null on error.
 * Re-throws PaymentUserError so user-facing messages propagate. */
export const safeAsync = async <T>(
  fn: () => Promise<T>,
  errorCode: ErrorCodeType,
): Promise<T | null> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PaymentUserError) throw err;
    const detail = err instanceof Error ? err.message : "unknown";
    logError({ code: errorCode, detail });
    return null;
  }
};

/**
 * Create a withClient helper that runs an operation with a lazily-resolved client.
 * Returns null if the client is not available or the operation fails.
 */
export const createWithClient =
  <Client>(getClient: () => Client | null | Promise<Client | null>) =>
  async <T>(
    op: (client: Client) => Promise<T>,
    errorCode: ErrorCodeType,
  ): Promise<T | null> => {
    const client = await getClient();
    return client ? safeAsync(() => op(client), errorCode) : null;
  };

/** Convert registration line items to compact booking items */
export const toBookingItems = (
  items: CartIntent["items"],
): BookingItem[] =>
  map(
    (i: CartIntent["items"][number]): BookingItem => ({
      e: i.eventId,
      q: i.quantity,
      p: i.unitPrice * i.quantity,
    }),
  )(items);

/**
 * Spread optional contact/date fields into metadata (only if truthy).
 *
 * This is the boundary where domain values (which may be undefined, null, or "")
 * are converted to metadata entries. Falsy values are excluded entirely — they
 * will become "" when extractSessionMetadata normalizes the metadata back.
 */
const optionalFields = (
  intent: Partial<
    Pick<ContactInfo, "phone" | "address" | "special_instructions">
  > & { date: string | null },
): Record<string, string> => ({
  ...(intent.phone ? { phone: intent.phone } : {}),
  ...(intent.address ? { address: intent.address } : {}),
  ...(intent.special_instructions
    ? { special_instructions: intent.special_instructions }
    : {}),
  ...(intent.date ? { date: intent.date } : {}),
});

/** Serialize per-event answer IDs for metadata (only if non-empty) */
const eventAnswerIdsField = (
  eventAnswerIds?: Record<string, number[]>,
): Record<string, string> =>
  eventAnswerIds && Object.keys(eventAnswerIds).length > 0
    ? { answer_ids: JSON.stringify(eventAnswerIds) }
    : {};

/** Convert single-event answerIds to the per-event format used in metadata */
export const singleEventAnswerIds = (
  eventId: number,
  answerIds?: number[],
): Record<string, number[]> | undefined =>
  answerIds?.length ? { [String(eventId)]: answerIds } : undefined;

/**
 * Build metadata for a single-event checkout.
 * Wraps the event + intent into the items array format used by buildMetadata.
 */
export const buildSingleItemMetadata = (
  event: { id: number; unit_price: number },
  intent: RegistrationIntent,
): Record<string, string> =>
  buildMetadata({
    ...intent,
    items: [{
      e: event.id,
      q: intent.quantity,
      p: (intent.customUnitPrice ?? event.unit_price) * intent.quantity,
    }],
    eventAnswerIds: singleEventAnswerIds(event.id, intent.answerIds),
  });

/** Input for building checkout metadata (all checkouts use items array) */
type MetadataIntent = {
  name: string;
  email: string;
  phone?: string;
  address?: string;
  special_instructions?: string;
  date: string | null;
  items: BookingItem[];
  eventAnswerIds?: Record<string, number[]>;
};

/**
 * Build multi-event checkout metadata from a CartIntent.
 */
export const buildItemsMetadata = (
  intent: CartIntent,
): Record<string, string> =>
  buildMetadata({
    ...intent,
    items: toBookingItems(intent.items),
  });

/**
 * Build checkout session metadata. All checkouts (single or multiple events)
 * use the same items array format.
 */
export const buildMetadata = (
  intent: MetadataIntent,
): Record<string, string> => ({
  _origin: getEffectiveDomain(),
  name: intent.name,
  email: intent.email,
  items: JSON.stringify(intent.items),
  ...optionalFields(intent),
  ...eventAnswerIdsField(intent.eventAnswerIds),
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
 * Validate that session metadata contains required fields (name + items).
 */
export const hasRequiredSessionMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): metadata is SessionMetadata => {
  if (!metadata?.name) return false;
  return !!metadata.items;
};

/**
 * Normalize validated session metadata into the canonical SessionMetadata shape.
 *
 * Must only be called after hasRequiredSessionMetadata narrows the type —
 * name is guaranteed non-empty by that guard. Optional fields that were
 * omitted during metadata creation are normalized to "" here.
 */
export const extractSessionMetadata = (
  metadata: SessionMetadata,
): ValidatedPaymentSession["metadata"] => ({
  _origin: metadata._origin || "",
  name: metadata.name,
  email: metadata.email || "",
  phone: metadata.phone || "",
  address: metadata.address || "",
  special_instructions: metadata.special_instructions || "",
  date: metadata.date || "",
  items: metadata.items || "",
  answer_ids: metadata.answer_ids || "",
});

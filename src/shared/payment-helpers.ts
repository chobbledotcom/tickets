/**
 * Shared helpers for payment provider implementations.
 * Eliminates duplication between stripe.ts/square.ts and their provider adapters.
 */

import { lazyRef, map } from "#fp";
import { getBookingFeeAmount } from "#shared/booking-fee.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { ErrorCodeType, LogCategory } from "#shared/logger.ts";
import { logDebug, logError } from "#shared/logger.ts";
import type {
  BookingIntent,
  BookingItem,
  CheckoutIntent,
  CheckoutSessionResult,
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import type { ContactInfo } from "#shared/types.ts";

/** Extract a human-readable message from an unknown caught value */
export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : "Unknown error";

/** Shared shape for a provider credential check in connection-test results. */
export type CredentialCheck = {
  valid: boolean;
  error?: string;
  mode?: string;
};

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
 * Cache a provider API client keyed on its config.
 * Reuses the cached client while the config is unchanged and recreates it
 * when the config changes; returns null when the provider is unconfigured.
 */
export const cachedClientFactory = <Config, Client>(opts: {
  provider: LogCategory;
  missingMessage: string;
  getConfig: () => Config | null;
  isSameConfig: (a: Config, b: Config) => boolean;
  create: (config: Config) => Client | Promise<Client>;
  createMessage?: (config: Config) => string;
}): { getClient: () => Promise<Client | null>; reset: () => void } => {
  type Entry = { client: Client; config: Config };
  const [getCache, setCache] = lazyRef<Entry | null>(() => null);
  const getClient = async (): Promise<Client | null> => {
    const config = opts.getConfig();
    if (config === null) {
      logDebug(opts.provider, opts.missingMessage);
      return null;
    }
    const cached = getCache();
    if (cached && opts.isSameConfig(cached.config, config)) {
      logDebug(opts.provider, `Using cached ${opts.provider} client`);
      return cached.client;
    }
    logDebug(
      opts.provider,
      opts.createMessage?.(config) ?? `Creating new ${opts.provider} client`,
    );
    const client = await opts.create(config);
    setCache({ client, config });
    return client;
  };
  return { getClient, reset: () => setCache(null) };
};

/**
 * Build a provider fee line-item array from the configured booking fee.
 * Returns [] when the fee is zero, else a single item shaped by `build`.
 */
export const feeLineItems = <Item>(
  subtotal: number,
  currency: string,
  build: (amount: number, currency: string) => Item,
): Item[] => {
  const amount = getBookingFeeAmount(subtotal);
  return amount > 0 ? [build(amount, currency)] : [];
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
export const toBookingItems = (items: CheckoutIntent["items"]): BookingItem[] =>
  map(
    (i: CheckoutIntent["items"][number]): BookingItem => ({
      e: i.listingId,
      p: i.unitPrice * i.quantity,
      q: i.quantity,
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

/** Serialize per-listing answer IDs for metadata (only if non-empty) */
const listingAnswerIdsField = (
  listingAnswerIds?: Record<string, number[]>,
): Record<string, string> =>
  listingAnswerIds && Object.keys(listingAnswerIds).length > 0
    ? { answer_ids: JSON.stringify(listingAnswerIds) }
    : {};

/** Convert single-listing answerIds to the per-listing format used in metadata */
export const singleListingAnswerIds = (
  listingId: number,
  answerIds?: number[],
): Record<string, number[]> | undefined =>
  answerIds?.length ? { [String(listingId)]: answerIds } : undefined;

/**
 * Build checkout metadata from a CheckoutIntent (converts items to compact form).
 *
 * Hashes the plain `siteToken` into `site_token_index` before storing so the
 * provider never sees a value that can be used at /renew.
 */
export const buildItemsMetadata = async (
  intent: CheckoutIntent,
): Promise<Record<string, string>> =>
  buildMetadata({
    ...intent,
    items: toBookingItems(intent.items),
    siteTokenIndex: intent.siteToken
      ? await hmacHash(intent.siteToken)
      : undefined,
  });

/** Input for buildMetadata — like BookingIntent but with optional contact fields */
type MetadataInput = Pick<BookingIntent, "name" | "email" | "items" | "date"> &
  Partial<
    Pick<
      BookingIntent,
      | "phone"
      | "address"
      | "special_instructions"
      | "listingAnswerIds"
      | "siteTokenIndex"
      | "balanceAttendeeId"
      | "reservationAmount"
    >
  >;

/**
 * Build checkout session metadata from booking data (items already compact).
 */
export const buildMetadata = (
  intent: MetadataInput,
): Record<string, string> => ({
  _origin: getEffectiveDomain(),
  email: intent.email,
  items: JSON.stringify(intent.items),
  name: intent.name,
  ...optionalFields(intent),
  ...listingAnswerIdsField(intent.listingAnswerIds),
  ...(intent.siteTokenIndex ? { site_token_index: intent.siteTokenIndex } : {}),
  ...(intent.balanceAttendeeId
    ? { balance_attendee_id: String(intent.balanceAttendeeId) }
    : {}),
  ...(intent.reservationAmount
    ? { reservation_amount: intent.reservationAmount }
    : {}),
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
  return { checkoutUrl: url, sessionId };
};

/**
 * Wrap a checkout operation, converting PaymentUserError to { error } result
 * and swallowing unexpected errors as null. Used by both provider adapters.
 */
export const withCheckoutError = async (
  op: () => Promise<CheckoutSessionResult>,
): Promise<CheckoutSessionResult> => {
  try {
    return await op();
  } catch (err) {
    if (err instanceof PaymentUserError) return { error: err.message };
    return null;
  }
};

/** Stripe metadata constraint: each value max 500 characters */
export const STRIPE_METADATA_MAX_VALUE_LENGTH = 500;

/** Square metadata constraint: each value max 255 characters */
export const SQUARE_METADATA_MAX_VALUE_LENGTH = 255;

/**
 * Enforce metadata value length limits for a payment provider.
 *
 * Only items and answer_ids can realistically exceed provider limits —
 * they grow with the number of listings/options selected. All other fields
 * (name, email, address, etc.) are already constrained by form validation
 * to lengths well below the smallest provider limit (255).
 */
export const enforceMetadataLimits = (
  metadata: Record<string, string>,
  maxValueLength: number,
): Record<string, string> => {
  const items = metadata.items;
  if (items && items.length > maxValueLength) {
    throw new PaymentUserError(
      "Too many listings selected for a single checkout. Please book in smaller batches.",
    );
  }

  const answerIds = metadata.answer_ids;
  if (answerIds && answerIds.length > maxValueLength) {
    throw new PaymentUserError(
      "Too many options selected for a single checkout. Please book in smaller batches.",
    );
  }

  return metadata;
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
  address: metadata.address || "",
  answer_ids: metadata.answer_ids || "",
  balance_attendee_id: metadata.balance_attendee_id || "",
  date: metadata.date || "",
  email: metadata.email || "",
  items: metadata.items || "",
  name: metadata.name,
  phone: metadata.phone || "",
  reservation_amount: metadata.reservation_amount || "",
  site_token_index: metadata.site_token_index || "",
  special_instructions: metadata.special_instructions || "",
});

/**
 * Shared helpers for payment provider implementations.
 * Eliminates duplication between stripe.ts/square.ts and their provider adapters.
 */

import { signedEdgeFor } from "#booking/signed-metadata.ts";
import { hmacHash } from "#crypto/hashing.ts";
import { sealCheckoutBundle } from "#db/checkout-bundles.ts";
import { settings } from "#db/settings.ts";
import { lazyRef, map } from "#fp";
import type {
  BookingIntent,
  BookingItem,
  ModifierRef,
} from "#shared/booking-intent.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import {
  type ErrorCodeType,
  type LogCategory,
  logDebug,
  logError,
} from "#shared/logger.ts";
import { namedError } from "#shared/named-error.ts";
import { parseDateMs } from "#shared/now.ts";
import {
  PAYMENT_PROVIDERS,
  type PaymentProviderMeta,
} from "#shared/payment-providers.ts";
import { signPrice } from "#shared/payment-signature.ts";
import type {
  CheckoutIntent,
  CheckoutSessionResult,
  WebhookEvent,
  WebhookVerifyResult,
} from "#shared/payments.ts";
import type { ContactInfo, PaymentProviderType } from "#types";

/**
 * Normalise a provider timestamp to the ledger's canonical ISO 8601 form
 * (`YYYY-MM-DDTHH:mm:ss.sssZ`), or undefined when it's absent or unparseable.
 *
 * Providers return assorted shapes — SumUp uses a `+00:00` offset, Square may
 * omit milliseconds — but the ledger validator accepts only the exact canonical
 * form. Normalising here, where a session is built, keeps `createdAt` safe to
 * use as a ledger `occurredAt` without a paid booking throwing at post time.
 */
export const toCanonicalIso = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined) return;
  const ms = parseDateMs(value);
  return ms === null ? undefined : new Date(ms).toISOString();
};

/** Error subclass for user-facing payment validation errors (e.g. invalid phone number).
 * These propagate to the user through the guarded runners. */
export class PaymentUserError extends namedError("PaymentUserError") {}

interface AsyncErrorHandling {
  errorDetail?: ((err: unknown) => string) | undefined;
  replaceError?: ((err: unknown) => Error) | undefined;
  shouldPropagate?: ((err: unknown) => boolean) | undefined;
}

const guardedWithValue =
  <Value>(
    getValue: () => Value | null | Promise<Value | null>,
    {
      errorDetail = (err) => (err instanceof Error ? err.message : "unknown"),
      replaceError,
      shouldPropagate = () => false,
    }: AsyncErrorHandling = {},
  ) =>
  async <T>(
    fn: (value: Value) => Promise<T>,
    errorCode: ErrorCodeType,
  ): Promise<T | null> => {
    const value = await getValue();
    if (value === null) return null;
    try {
      return await fn(value);
    } catch (err) {
      if (replaceError !== undefined) throw replaceError(err);
      if (err instanceof PaymentUserError || shouldPropagate(err)) throw err;
      logError({ code: errorCode, detail: errorDetail(err) });
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

/** Run an operation with the lazily-resolved client. Returns null when the
 * client is unconfigured or the operation fails (unless the error should
 * propagate). The named type keeps the contract visible to callers of the
 * widely-used provider runners so a signature drift fails at the definition
 * instead of leaking to callers. */
export type ClientRunner<Client> = <T>(
  fn: (value: Client) => Promise<T>,
  errorCode: ErrorCodeType,
) => Promise<T | null>;

/**
 * Create a withClient helper that runs an operation with a lazily-resolved client.
 * Returns null if the client is not available or the operation fails.
 */
export const createWithClient = <Client>(
  getClient: () => Client | null | Promise<Client | null>,
  errorHandling: AsyncErrorHandling = {},
): ClientRunner<Client> => guardedWithValue(getClient, errorHandling);

/** Convert registration line items to compact, edge-tagged booking items (v2).
 * Each package member line carries ITS OWN package edge (`k:"p"`, `r`=its group
 * id) so the webhook can revalidate each line's `nodeKey` — an order can book
 * several packages, so the edge is per line, never order-wide; folded children
 * (in `allocations`) and standalone lines stay untagged. See signed-metadata.ts. */
export const toBookingItems = (intent: CheckoutIntent): BookingItem[] => {
  const foldedChildIds = new Set(
    (intent.allocations ?? []).map((a) => a.childId),
  );
  return map(
    (i: CheckoutIntent["items"][number]): BookingItem => ({
      e: i.listingId,
      p: i.unitPrice * i.quantity,
      q: i.quantity,
      ...signedEdgeFor(i.packageGroupId, foldedChildIds.has(i.listingId)),
    }),
  )(intent.items);
};

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
  > & { date: string | null; dayCount?: number | undefined },
): Record<string, string> => ({
  ...(intent.phone ? { phone: intent.phone } : {}),
  ...(intent.address ? { address: intent.address } : {}),
  ...(intent.special_instructions
    ? { special_instructions: intent.special_instructions }
    : {}),
  ...(intent.date ? { date: intent.date } : {}),
  ...(intent.dayCount ? { day_count: String(intent.dayCount) } : {}),
});

/** Serialize a per-listing answer map for metadata, or nothing when it is empty. */
const answerIdsField =
  (name: string) =>
  (byListing?: Record<string, unknown>): Record<string, string> =>
    byListing && Object.keys(byListing).length > 0
      ? { [name]: JSON.stringify(byListing) }
      : {};

const listingAnswerIdsField = answerIdsField("answer_ids");
const listingTextAnswerIdsField = answerIdsField("text_answer_ids");

/** Convert single-listing answerIds to the per-listing format used in metadata */
export const singleListingAnswerIds = (
  listingId: number,
  answerIds?: number[],
): Record<string, number[]> | undefined =>
  answerIds?.length ? { [String(listingId)]: answerIds } : undefined;

/**
 * The order of a checkout as the record the webhook reads back. The plain
 * `siteToken` is hashed FIRST, so no stored copy is usable at /renew.
 */
const orderRecord = async (
  intent: CheckoutIntent,
): Promise<Record<string, string>> => {
  const modifiers = toModifierRefs(intent.modifiers);
  const siteTokenIndex = intent.siteToken
    ? await hmacHash(intent.siteToken)
    : undefined;
  const {
    modifiers: _modifiers,
    siteToken: _siteToken,
    thankYouUrl,
    ...intentRest
  } = intent;
  return buildMetadata({
    ...intentRest,
    items: toBookingItems(intent),
    taxPolicy: intent.taxPolicy ?? settings.tax,
    ...(thankYouUrl !== undefined ? { thankYouUrl } : {}),
    ...(modifiers !== undefined ? { modifiers } : {}),
    ...(siteTokenIndex !== undefined ? { siteTokenIndex } : {}),
  });
};

/** Sign the agreed total, bound to every field the metadata carries, so the
 * webhook can trust it as an oracle rather than re-deriving and hoping they
 * agree. `total` is the price the caller already agreed, so the proof and the
 * charged amount cannot disagree if pricing changes mid-checkout. */
const withPriceProof = (
  metadata: Record<string, string>,
  total: number,
): Record<string, string> => ({
  ...metadata,
  price_proof: `${total}.${signPrice(metadata, total)}`,
});

/**
 * What a card provider stores for a checkout: a token that opens the sealed
 * order, and the first listing so an admin can be told where a lost order
 * belonged. Both are signed, so the token cannot be swapped.
 */
const sealedOrderMetadata = async (
  record: Record<string, string>,
  intent: CheckoutIntent,
): Promise<Record<string, string>> => ({
  _origin: record._origin!,
  bundle: await sealCheckoutBundle(record),
  listing: String(intent.items[0]!.listingId),
});

/**
 * Build a checkout's signed metadata for the given provider. A provider that
 * keeps no order of its own gets the whole order sealed in our database, and
 * its metadata holds only the token, so no cap on metadata can refuse an
 * order. A provider whose checkout is staged locally already holds the order
 * (SumUp), so the record goes there whole.
 */
export const assembleCheckoutMetadata = async (
  providerType: PaymentProviderType,
  intent: CheckoutIntent,
  total: number,
): Promise<Record<string, string>> => {
  const record = await orderRecord(intent);
  const { orderCarrier }: PaymentProviderMeta = PAYMENT_PROVIDERS[providerType];
  return withPriceProof(
    orderCarrier === "sealed-bundle"
      ? await sealedOrderMetadata(record, intent)
      : record,
    total,
  );
};

/**
 * Compact the resolved modifier specs to id/quantity references for metadata.
 *
 * Every trigger (automatic, code, opt-in add-on, and answer) is carried the
 * same way — its modifier id and the resolved quantity — and the webhook
 * re-fetches each by id, re-checking eligibility (the returning-customer visit
 * gate) and re-deriving the amount, so provider metadata amounts are never
 * trusted. Answer-triggered modifiers are ordinary modifier rows now, so their
 * ids can't collide with anything: the resolved (stock-clamped) quantity stored
 * here is exactly what the webhook re-prices, keeping the two totals identical.
 */
export const toModifierRefs = (
  specs: CheckoutIntent["modifiers"],
): ModifierRef[] | undefined =>
  specs && specs.length > 0
    ? specs.map((s) => ({ i: s.id, q: s.quantity }))
    : undefined;

/** Input for buildMetadata — like BookingIntent but with optional contact fields */
type MetadataInput = Pick<BookingIntent, "name" | "email" | "items" | "date"> &
  Partial<
    Pick<
      BookingIntent,
      | "phone"
      | "address"
      | "special_instructions"
      | "dayCount"
      | "listingAnswerIds"
      | "listingTextAnswerIds"
      | "siteTokenIndex"
      | "balanceAttendeeId"
      | "reservationAmount"
      | "modifiers"
      | "thankYouUrl"
      | "allocations"
      | "taxPolicy"
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
  ...listingTextAnswerIdsField(intent.listingTextAnswerIds),
  ...(intent.siteTokenIndex ? { site_token_index: intent.siteTokenIndex } : {}),
  ...(intent.balanceAttendeeId
    ? { balance_attendee_id: String(intent.balanceAttendeeId) }
    : {}),
  ...(intent.reservationAmount
    ? { reservation_amount: intent.reservationAmount }
    : {}),
  ...(intent.modifiers?.length
    ? { modifiers: JSON.stringify(intent.modifiers) }
    : {}),
  ...(intent.taxPolicy ? { tax_policy: JSON.stringify(intent.taxPolicy) } : {}),
  ...(intent.thankYouUrl ? { thank_you_url: intent.thankYouUrl } : {}),
  ...(intent.allocations?.length
    ? { allocations: JSON.stringify(intent.allocations) }
    : {}),
});

/**
 * Wrap a checkout operation, converting PaymentUserError to { error } and
 * letting unexpected failures propagate. Used by both provider adapters.
 */
export const withCheckoutError = async (
  op: () => Promise<CheckoutSessionResult>,
): Promise<CheckoutSessionResult> => {
  try {
    return await op();
  } catch (err) {
    if (err instanceof PaymentUserError) return { error: err.message };
    throw err;
  }
};

const UNREADABLE_WEBHOOK: WebhookVerifyResult = {
  error: "Invalid JSON payload",
  valid: false,
};

/** The one door every webhook body comes through. A body that is not JSON is
 * refused the same way for every provider. What the body then means differs —
 * a signed provider posts the event itself, SumUp posts two fields we build one
 * from — so each provider passes its own reading, run outside the catch so a
 * bug in it never reads as bad JSON. A reading that answers nothing means the
 * body is JSON this provider cannot read, which earns the same refusal. */
export const parseWebhookPayload = (
  payload: string,
  errorCode: ErrorCodeType,
  toEvent: (body: unknown) => WebhookEvent | null,
): WebhookVerifyResult => {
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch (err) {
    logError({ code: errorCode, detail: `invalid JSON: ${err}` });
    return UNREADABLE_WEBHOOK;
  }
  const listing = toEvent(body);
  if (listing === null) {
    logError({ code: errorCode, detail: "JSON payload is not an event" });
    return UNREADABLE_WEBHOOK;
  }
  return { listing, valid: true };
};

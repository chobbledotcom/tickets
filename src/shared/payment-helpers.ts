/**
 * Shared helpers for payment provider implementations.
 * Eliminates duplication between stripe.ts/square.ts and their provider adapters.
 */

import { lazyRef, map } from "#fp";
import type {
  ExtraLine,
  PricedLine,
  PricedOrder,
} from "#shared/checkout-pricing.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { ErrorCodeType, LogCategory } from "#shared/logger.ts";
import { logDebug, logError } from "#shared/logger.ts";
import { signPriceSync } from "#shared/payment-signature.ts";
import type {
  BookingIntent,
  BookingItem,
  CheckoutIntent,
  CheckoutSessionResult,
  ModifierRef,
  SessionMetadata,
  ValidatedPaymentSession,
  WebhookEvent,
  WebhookVerifyResult,
} from "#shared/payments.ts";
import type { ContactInfo } from "#shared/types.ts";

/** Extract a human-readable message from an unknown caught value */
export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : "Unknown error";

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
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};

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
 * Render a priced order into a provider's line-item array: each ticket line via
 * `line`, each extra (booking fee, …) via `extra`. Providers supply the two
 * shape callbacks; the ordering (tickets, then extras) matches what Stripe and
 * Square built by hand before.
 */
export const buildProviderLineItems = <Item>(
  order: PricedOrder,
  currency: string,
  render: {
    line: (line: PricedLine, currency: string) => Item;
    extra: (extra: ExtraLine, currency: string) => Item;
  },
): Item[] => [
  ...order.lines.map((line) => render.line(line, currency)),
  ...order.extras.map((extra) => render.extra(extra, currency)),
];

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

/** Serialize per-listing answer IDs for metadata (only if non-empty) */
const listingAnswerIdsField = (
  listingAnswerIds?: Record<string, number[]>,
): Record<string, string> =>
  listingAnswerIds && Object.keys(listingAnswerIds).length > 0
    ? { answer_ids: JSON.stringify(listingAnswerIds) }
    : {};

const listingTextAnswerIdsField = (
  listingTextAnswerIds?: BookingIntent["listingTextAnswerIds"],
): Record<string, string> =>
  listingTextAnswerIds && Object.keys(listingTextAnswerIds).length > 0
    ? { text_answer_ids: JSON.stringify(listingTextAnswerIds) }
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
 *
 * `total` is the agreed order total the provider is billing for. The caller
 * prices the order once and passes that same total here, so the signed proof
 * and the charged amount can never disagree even if pricing settings change
 * mid-checkout (re-pricing here would reopen that window — see #1300).
 *
 * `maxValueLength` is the provider's per-value metadata cap, and `maxEntries`
 * its optional entry-count cap (Square's 10; Stripe/SumUp omit it). The one
 * provider-cap-sensitive field that must **not** fail the checkout is
 * `thank_you_url`: a folded paid parent copies its operator-configured URL into
 * metadata, but it can break session creation for an order that is otherwise
 * valid in **two** ways — a long URL exceeds the per-value cap, OR (even a short
 * URL) it is one extra top-level entry that tips a full payload over the
 * ENTRY-count cap once the small fields are packed. It is purely a
 * post-completion redirect and the LAST-priority optional field to drop, so an
 * over-cap URL (by either limit) is **omitted before signing** (the order
 * completes and falls back to the generic success page). Dropping it *before*
 * `signPriceSync` keeps the signed payload and the emitted metadata identical,
 * so the webhook's unpack-then-verify never sees a key the proof was signed with
 * but the wire omitted (which would classify the paid session as tampered —
 * parents.md Fix 3). The entry count is judged against the **packed** shape (the
 * provider packs before emitting) plus the `price_proof` entry added below,
 * matching exactly what reaches the wire.
 */
/**
 * Whether the optional `thank_you_url` can be kept in the metadata: it must be
 * present, within the provider's per-value length cap, AND — when the provider
 * caps the entry count (Square) — leave room for itself plus the `price_proof`
 * entry once the small fields are packed. `withoutUrl` is the metadata built
 * without the URL; the wire entry count with the URL kept is its packed-size
 * plus the URL (a top-level, non-packed entry) plus `price_proof`. The URL is
 * the LAST-priority optional field to drop, so it is the only one omitted when
 * the payload would otherwise overflow (parents.md Fix 3).
 */
const thankYouUrlFits = (
  thankYouUrl: string | undefined,
  withoutUrl: Record<string, string>,
  caps: { maxValueLength: number; maxEntries?: number | undefined },
): boolean => {
  if (!thankYouUrl || thankYouUrl.length > caps.maxValueLength) return false;
  if (caps.maxEntries === undefined) return true;
  // +1 for the URL's own top-level entry, +1 for the price_proof entry added
  // after signing; both are counted against the *packed* baseline the wire uses.
  const wireEntries = Object.keys(packMetadata(withoutUrl)).length + 1 + 1;
  return wireEntries <= caps.maxEntries;
};

export const buildItemsMetadata = async (
  intent: CheckoutIntent,
  total: number,
  maxValueLength: number,
  maxEntries?: number,
): Promise<Record<string, string>> => {
  // Build the metadata without the optional thank-you URL once; this is also the
  // baseline whose entry count decides whether the URL can be added back below.
  const modifiers = toModifierRefs(intent.modifiers);
  const siteTokenIndex = intent.siteToken
    ? await hmacHash(intent.siteToken)
    : undefined;
  const {
    thankYouUrl: _thankYouUrl,
    modifiers: _modifiers,
    siteToken: _siteToken,
    ...intentRest
  } = intent;
  const withoutUrl = buildMetadata({
    ...intentRest,
    items: toBookingItems(intent.items),
    ...(modifiers !== undefined ? { modifiers } : {}),
    ...(siteTokenIndex !== undefined ? { siteTokenIndex } : {}),
  });
  const base = thankYouUrlFits(intent.thankYouUrl, withoutUrl, {
    maxEntries,
    maxValueLength,
  })
    ? { ...withoutUrl, thank_you_url: intent.thankYouUrl! }
    : withoutUrl;
  // Sign the agreed total bound to every stored booking field, so the webhook
  // can trust it as an oracle rather than re-deriving and hoping they agree.
  // Returns the logical (unpacked) shape; only Square packs the small fields
  // into `b` (for its 10-entry cap), so Stripe/SumUp keep each field top-level
  // and at their full per-value headroom. Signing is over this logical shape,
  // which the webhook reproduces after unpacking, so packing never changes the
  // digest.
  const sig = signPriceSync(base, total);
  return { ...base, price_proof: `${total}.${sig}` };
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
  ...(intent.thankYouUrl ? { thank_you_url: intent.thankYouUrl } : {}),
  ...(intent.allocations?.length
    ? { allocations: JSON.stringify(intent.allocations) }
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

/** Stripe metadata constraint: max 50 entries. */
export const STRIPE_METADATA_MAX_ENTRIES = 50;

/** Square metadata constraint: each value max 255 characters */
export const SQUARE_METADATA_MAX_VALUE_LENGTH = 255;

/** Square metadata constraint: max 10 entries — the tightest provider cap, and
 * the reason small fields are packed into one `b` entry (see packMetadata). */
export const SQUARE_METADATA_MAX_ENTRIES = 10;

/**
 * Small, bounded booking fields collapsed into a single packed `b` entry.
 *
 * Payment providers cap how many metadata entries a session may carry (Square
 * allows only 10), and a fully-populated checkout otherwise overflows it. These
 * fields are individually short — a date, a day count, a reservation snapshot —
 * so JSON-packing them into one entry frees slots without risking the per-value
 * length cap. Large or length-sensitive fields (items, answer_ids, address,
 * special_instructions, and modifiers — whose compact refs would double-encode
 * inside `b` and could exceed Square's 255-char value cap) and the
 * integrity-critical ones (_origin, name, email, price_proof) stay top-level,
 * where they keep their full per-value headroom, remain individually
 * length-checked, and are directly readable by the metadata guards.
 */
const PACKED_KEYS = [
  "phone",
  "date",
  "day_count",
  "reservation_amount",
  "balance_attendee_id",
  "site_token_index",
] as const;

/** The single metadata key the packed small fields are stored under. */
const PACKED_FIELD = "b";

/**
 * Collapse the packable small fields into one JSON `b` entry, dropping them
 * from the top level. Falsy values are omitted (the "" = absent convention), so
 * the `b` entry only appears when at least one packed field is actually present.
 */
export const packMetadata = (
  metadata: Record<string, string>,
): Record<string, string> => {
  const rest: Record<string, string> = { ...metadata };
  const packed: Record<string, string> = {};
  for (const key of PACKED_KEYS) {
    const value = rest[key];
    if (value) packed[key] = value;
    delete rest[key];
  }
  return Object.keys(packed).length > 0
    ? { ...rest, [PACKED_FIELD]: JSON.stringify(packed) }
    : rest;
};

/**
 * Recover the packed small fields from a `b` JSON blob.
 *
 * Defensive by design: a malformed blob, a non-object, or a non-string field
 * is treated as "no packed data" rather than throwing, so a corrupt `b` reaching
 * the webhook degrades each packed field to absent instead of crashing the
 * handler before the price signature can even be checked.
 */
const parsePackedFields = (raw: string): Partial<Record<string, string>> => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const source = parsed as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const key of PACKED_KEYS) {
      const value = source[key];
      if (typeof value === "string") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
};

/**
 * Enforce a payment provider's metadata limits.
 *
 * Only items, answer_ids and modifiers can realistically exceed the per-value
 * length limit — they grow with the number of listings/options/modifiers
 * selected (answer-triggered modifiers ride the modifiers refs). All other
 * fields (name, email, address, etc.) are already constrained by form
 * validation to lengths well below the smallest provider limit (255).
 *
 * Square also caps the *number* of entries: a customisable-day checkout that
 * fills its optional fields (date, day_count, answer_ids, …) plus a modifiers
 * ref can reach the 10-entry limit, so when `maxEntries` is supplied the key
 * count is checked too and surfaces the same batching error rather than a
 * generic provider rejection.
 *
 * `thank_you_url` is **not** handled here. It is the one provider-cap-sensitive
 * field that must not fail the checkout (a long operator URL on a folded paid
 * parent is purely a post-completion redirect), so an over-cap URL is dropped
 * **before** the metadata is signed, in `buildItemsMetadata`. Capping it here —
 * after `signPriceSync` — would strip a key the proof was signed with, so the
 * webhook's verification would classify the paid session as tampered. Bounding
 * it pre-sign keeps the signed payload and the emitted metadata identical
 * (parents.md Fix 1).
 */
export const enforceMetadataLimits = (
  metadata: Record<string, string>,
  maxValueLength: number,
  maxEntries?: number,
): Record<string, string> => {
  const items = metadata.items;
  if (items && items.length > maxValueLength) {
    throw new PaymentUserError(
      "Too many listings selected for a single checkout. Please book in smaller batches.",
    );
  }

  const answerIds = metadata.answer_ids;
  const textAnswerIds = metadata.text_answer_ids;
  const modifiers = metadata.modifiers;
  if (
    (answerIds && answerIds.length > maxValueLength) ||
    (textAnswerIds && textAnswerIds.length > maxValueLength) ||
    (modifiers && modifiers.length > maxValueLength) ||
    (maxEntries !== undefined && Object.keys(metadata).length > maxEntries)
  ) {
    throw new PaymentUserError(
      "Too many options selected for a single checkout. Please book in smaller batches.",
    );
  }

  // The packed `b` entry combines several small fields; with enough modifiers
  // (or a long site-token hash alongside them) the JSON blob can itself exceed
  // a provider's per-value cap, so it is length-checked like items/answer_ids.
  const packed = metadata[PACKED_FIELD];
  if (packed && packed.length > maxValueLength) {
    throw new PaymentUserError(
      "Too much booking detail for a single checkout. Please book in smaller batches.",
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
 * This is the single boundary where the provider wire format becomes the logical
 * shape the rest of the app (and the price-signature check) reads: any small
 * fields packed into `b` are merged back to the top level first, so every
 * consumer sees one consistent shape regardless of how it was stored. Must only
 * be called after hasRequiredSessionMetadata narrows the type — name is
 * guaranteed non-empty by that guard. Fields omitted at creation (or absent from
 * a malformed `b`) normalize to "".
 */
export const extractSessionMetadata = (
  metadata: SessionMetadata,
): ValidatedPaymentSession["metadata"] => {
  const raw = (metadata as { [PACKED_FIELD]?: string })[PACKED_FIELD];
  const packed = raw ? parsePackedFields(raw) : {};
  const get = (key: keyof SessionMetadata): string =>
    packed[key] || metadata[key] || "";
  return {
    _origin: get("_origin"),
    address: get("address"),
    allocations: get("allocations"),
    answer_ids: get("answer_ids"),
    balance_attendee_id: get("balance_attendee_id"),
    date: get("date"),
    day_count: get("day_count"),
    email: get("email"),
    items: get("items"),
    modifiers: get("modifiers"),
    name: metadata.name,
    phone: get("phone"),
    price_proof: get("price_proof"),
    reservation_amount: get("reservation_amount"),
    site_token_index: get("site_token_index"),
    special_instructions: get("special_instructions"),
    text_answer_ids: get("text_answer_ids"),
    thank_you_url: get("thank_you_url"),
  };
};

export const parseWebhookPayload = (
  payload: string,
  errorCode: ErrorCodeType,
): WebhookVerifyResult => {
  try {
    const listing = JSON.parse(payload) as WebhookEvent;
    return { listing, valid: true };
  } catch (err) {
    logError({ code: errorCode, detail: `invalid JSON: ${err}` });
    return { error: "Invalid JSON payload", valid: false };
  }
};

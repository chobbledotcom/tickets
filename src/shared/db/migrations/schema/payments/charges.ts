/* jscpd:ignore-start -- imports */
import {
  LEGACY_SOURCES,
  RECORD_ORIGINS,
  REFUND_STATES,
  RESOURCE_KINDS,
} from "#shared/payment-state/words.ts";
import { PaymentProviderSchema } from "#shared/types.ts";
import {
  allOf,
  alsoAbout,
  amountOrNull,
  anyOf,
  currencyOrNull,
  encryptedPaymentColumnOrNull,
  legacySealed,
  madeAndTouched,
  oneOf,
  oneOfOrNull,
  ownSealed,
  paymentRecord,
  quoted,
  wholeNumberOrNull,
  words,
  wordsOrNull,
} from "./columns.ts";

/* jscpd:ignore-end */

const PROVIDERS = PaymentProviderSchema.options;

/** Each provider names its money its own way, so the two must agree. */
const providerMatchesKind = anyOf(
  PROVIDERS.map(
    (provider, index) =>
      `(provider = '${provider}' AND resource_kind = '${RESOURCE_KINDS[index]}')`,
  ),
);

/** Which refund handles a charge may hold, for each place a refund has got to.
 *  A refund the provider is still working on is left open: it may have been
 *  started in the provider's own dashboard, so we may hold neither handle. */
const refundHandlesMatchState = anyOf([
  `(refund_state = 'requested' AND pending_refund_id IS NULL AND pending_refund_idempotency_key IS NOT NULL)`,
  `refund_state = 'pending'`,
  `(refund_state = 'failed' AND pending_refund_id IS NULL)`,
  `(refund_state IN ('none', 'partial', 'completed') AND pending_refund_id IS NULL AND pending_refund_idempotency_key IS NULL)`,
]);

/** Money taken here, which knows everything about itself. */
const moneyTakenHere = allOf([
  `origin = 'current'`,
  "legacy_source IS NULL",
  "provider_refunded_at IS NULL",
  ownSealed("provider_reference"),
  "reference_index IS NOT NULL",
  "captured_amount IS NOT NULL",
  "currency IS NOT NULL",
  "refunded_amount IS NOT NULL",
  "refunded_amount BETWEEN 0 AND captured_amount",
  `refund_state != 'unknown'`,
  "provider IS NOT NULL",
  "resource_kind IS NOT NULL",
  providerMatchesKind,
  refundHandlesMatchState,
  `(refund_state NOT IN ('requested', 'pending') OR refunded_amount < captured_amount)`,
  `(refund_state != 'none' OR refunded_amount = 0)`,
  `(refund_state != 'partial' OR (refunded_amount > 0 AND refunded_amount < captured_amount))`,
  `(refund_state != 'completed' OR refunded_amount = captured_amount)`,
]);

/** Money copied across on upgrade, which knows only that it happened. */
const moneyCopiedAcross = allOf([
  `origin = 'legacy'`,
  "provider IS NULL",
  "resource_kind IS NULL",
  legacySealed("provider_reference"),
  "reference_index IS NULL",
  "captured_amount IS NULL",
  "currency IS NULL",
  "refunded_amount IS NULL",
  `refund_state = 'unknown'`,
  "pending_refund_id IS NULL",
  "pending_refund_index IS NULL",
  "pending_refund_idempotency_key IS NULL",
  "pending_refund_key_index IS NULL",
  "legacy_source IS NOT NULL",
  `legacy_source IN (${quoted(LEGACY_SOURCES)})`,
]);

/** What a charge may never be, whatever else is true of it. */
const aboutTheCharge = alsoAbout([
  `typeof(observed_at) = 'integer' AND observed_at >= 0`,
  anyOf([moneyTakenHere, moneyCopiedAcross]),
  "(pending_refund_id IS NULL) = (pending_refund_index IS NULL)",
  "(pending_refund_idempotency_key IS NULL) = (pending_refund_key_index IS NULL)",
  encryptedPaymentColumnOrNull("pending_refund_id"),
  encryptedPaymentColumnOrNull("pending_refund_idempotency_key"),
]);

export const paymentChargeTable = paymentRecord("payment_charges", {
  columns: [
    ["origin", oneOf("origin", RECORD_ORIGINS, "current")],
    ["provider", oneOfOrNull("provider", PROVIDERS)],
    ["resource_kind", oneOfOrNull("resource_kind", RESOURCE_KINDS)],
    ["provider_reference", words("provider_reference")],
    ["reference_index", wordsOrNull("reference_index")],
    ["captured_amount", amountOrNull("captured_amount", 1)],
    ["currency", currencyOrNull("currency")],
    ["refunded_amount", wholeNumberOrNull("refunded_amount")],
    ["refund_state", oneOf("refund_state", REFUND_STATES, "none")],
    ["pending_refund_id", "TEXT"],
    ["pending_refund_index", wordsOrNull("pending_refund_index")],
    ["pending_refund_idempotency_key", "TEXT"],
    ["pending_refund_key_index", wordsOrNull("pending_refund_key_index")],
    // A time, like every other time here, so it can be compared with them.
    // SQLite sorts numbers before text whatever they say, so one time kept
    // as words would always read as later than one kept as a number.
    ["provider_refunded_at", wholeNumberOrNull("provider_refunded_at")],
    ["legacy_source", "TEXT"],
    ...madeAndTouched,
    ["observed_at", aboutTheCharge("INTEGER NOT NULL")],
  ],
  indexes: [
    {
      columns: ["payment_id", "reference_index"],
      name: "idx_payment_charges_payment_reference",
      unique: true,
    },
    {
      columns: ["reference_index"],
      name: "idx_payment_charges_reference",
    },
    {
      columns: ["pending_refund_index"],
      name: "idx_payment_charges_pending_refund",
    },
    {
      columns: ["payment_id", "legacy_source"],
      name: "idx_payment_charges_legacy_source",
      unique: true,
    },
  ],
});

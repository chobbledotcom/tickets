/* jscpd:ignore-start -- imports */
import {
  RECORD_ORIGINS,
  REFUND_STATES,
  RESOURCE_KINDS,
} from "#shared/payment-state/words.ts";
import { PaymentProviderSchema } from "#shared/types.ts";
import {
  alsoAbout,
  amountOrNull,
  anyOf,
  currencyOrNull,
  encryptedPaymentColumnOrNull,
  madeAndTouched,
  oneOf,
  oneOfOrNull,
  paymentRecord,
  sealedEitherWay,
  wholeNumberOrNull,
  wordsOrNull,
} from "./columns.ts";

/* jscpd:ignore-end */

const PROVIDERS = PaymentProviderSchema.options;

/** Each provider names its money its own way, so when a charge says both, the
 *  two have to agree. Which name goes with which provider does not change. */
const providerMatchesKind = anyOf(
  PaymentProviderSchema.options.map(
    (provider, index) =>
      `(provider = '${provider}' AND resource_kind = '${RESOURCE_KINDS[index]}')`,
  ),
);

/** What a charge may never be, whatever else is true of it. */
const aboutTheCharge = alsoAbout([
  `typeof(observed_at) = 'integer' AND observed_at >= 0`,
  // Money can never be given back beyond what was taken. This holds whatever
  // the refund is doing, so it belongs with the money rather than the runtime.
  "refunded_amount IS NULL OR captured_amount IS NULL OR refunded_amount BETWEEN 0 AND captured_amount",
  `provider IS NULL OR resource_kind IS NULL OR ${providerMatchesKind}`,
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
    ["provider_reference", sealedEitherWay("provider_reference")],
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
    [
      "provider_refunded_at",
      wholeNumberOrNull("provider_refunded_at", "observed_at"),
    ],
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

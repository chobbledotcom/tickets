import {
  alsoAbout,
  encryptedPaymentColumnOrNull,
  madeAndTouched,
  paymentRecord,
  sealedEitherWay,
  wholeNumberOrNull,
  words,
  wordsOrNull,
} from "./columns.ts";

/* jscpd:ignore-end */

/** Each provider names its money its own way, so when a charge says both, the
 *  two have to agree. Which name goes with which provider does not change. */
/** The only rule the table keeps: the buyer's details really are hidden. */
const aboutTheCharge = alsoAbout([
  encryptedPaymentColumnOrNull("pending_refund_id"),
  encryptedPaymentColumnOrNull("pending_refund_idempotency_key"),
]);

export const paymentChargeTable = paymentRecord("payment_charges", {
  columns: [
    ["origin", words("current")],
    ["provider", wordsOrNull()],
    ["resource_kind", wordsOrNull()],
    ["provider_reference", sealedEitherWay("provider_reference")],
    ["reference_index", wordsOrNull()],
    ["captured_amount", wholeNumberOrNull()],
    ["currency", wordsOrNull()],
    ["refunded_amount", wholeNumberOrNull()],
    ["refund_state", words("none")],
    ["pending_refund_id", "TEXT"],
    ["pending_refund_index", wordsOrNull()],
    ["pending_refund_idempotency_key", "TEXT"],
    ["pending_refund_key_index", wordsOrNull()],
    // A time, like every other time here, so it can be compared with them.
    // SQLite sorts numbers before text whatever they say, so one time kept
    // as words would always read as later than one kept as a number.
    ["provider_refunded_at", wholeNumberOrNull()],
    // Named outright rather than left as any words at all: only one charge may
    // be copied from a given old table per payment, so anything the upgrade
    // does not know about would be a second, distinct "nowhere" that the
    // unique index happily accepts.
    ["legacy_source", wordsOrNull()],
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

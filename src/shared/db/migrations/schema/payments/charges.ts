/* jscpd:ignore-start -- imports */
import {
  alsoAbout,
  encryptedPaymentColumnOrNull,
  madeAndTouched,
  paymentRecord,
  sealedEitherWay,
  wholeNumber,
  wholeNumberOrNull,
  words,
  wordsOrNull,
} from "./columns.ts";

/* jscpd:ignore-end */

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
    ["pending_refund_id", wordsOrNull()],
    ["pending_refund_index", wordsOrNull()],
    ["pending_refund_idempotency_key", wordsOrNull()],
    ["pending_refund_key_index", wordsOrNull()],
    // A time, like every other time here, so it can be compared with them.
    // SQLite sorts numbers before text whatever they say, so one time kept
    // as words would always read as later than one kept as a number.
    ["provider_refunded_at", wholeNumberOrNull()],
    ["legacy_source", wordsOrNull()],
    ...madeAndTouched,
    ["observed_at", aboutTheCharge(wholeNumber())],
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

/* jscpd:ignore-start -- imports */
import {
  aboutTheRow,
  rowId,
  text,
  textOrNull,
  wholeNumber,
  wholeNumberOrNull,
  wholeNumberStartingAtOne,
  wholeNumberStartingAtZero,
} from "#db/migrations/schema/scalar-columns.ts";
import type { Table } from "#db/migrations/schema/types.ts";
import { refundAuthorityWorkSql } from "#payment/refund-authority-lifecycle.ts";
import { madeAndTouched, ownerEncryptedColumn } from "./columns.ts";

/* jscpd:ignore-end */

/** Rules the database can prove without understanding the whole state machine. */
const ABOUT_THE_CHARGE = [
  "provider IN ('stripe', 'square', 'sumup')",
  "reference_index <> ''",
  "capability IN ('keyed', 'keyless')",
  "captured_amount >= 0",
  "refunded_amount >= 0",
  "length(currency) = 3 AND currency = upper(currency)",
  "json_valid(refund_state)",
  "json_type(refund_state) = 'object'",
  "refund_state_name IN ('ready', 'send_armed', 'observing', 'completed', 'needs_owner_choice', 'needs_provider_check')",
  "refund_local_state IN ('not_due', 'due', 'recorded')",
  "json_type(refund_state, '$.kind') IS 'text'",
  "json_type(refund_state, '$.request.capability') IS 'text'",
  "json_type(refund_state, '$.local.kind') IS 'text'",
  "json_type(refund_state, '$.nextActionAt') IS NOT NULL",
  "json_extract(refund_state, '$.kind') = refund_state_name",
  "json_extract(refund_state, '$.request.capability') = capability",
  "json_extract(refund_state, '$.local.kind') = refund_local_state",
  "json_extract(refund_state, '$.nextActionAt') IS next_refund_action_at",
  "refund_revision >= 1",
];

export const paymentChargeTable: [name: string, table: Table] = [
  "payment_charges",
  {
    columns: [
      ["id", rowId],
      ["provider", text],
      ownerEncryptedColumn("provider_reference"),
      ["reference_index", text],
      ["callback_replay_index", textOrNull],
      ["capability", text],
      ["captured_amount", wholeNumber],
      ["currency", text],
      ["refunded_amount", wholeNumberStartingAtZero],
      ["refund_state", text],
      ["refund_state_name", text],
      ["refund_local_state", text],
      ["next_refund_action_at", wholeNumberOrNull],
      ["refund_revision", wholeNumberStartingAtOne],
      ...madeAndTouched,
      ["observed_at", aboutTheRow(ABOUT_THE_CHARGE)(wholeNumber)],
    ],
    indexes: [
      {
        columns: ["reference_index"],
        name: "idx_payment_charges_reference",
        unique: true,
      },
      {
        columns: ["callback_replay_index"],
        name: "idx_payment_charges_callback_replay",
        unique: true,
      },
      {
        columns: ["next_refund_action_at", "id"],
        name: "idx_payment_charges_next_action",
        where: "next_refund_action_at IS NOT NULL",
      },
      {
        columns: ["id"],
        name: "idx_payment_charges_refund_state",
        where: refundAuthorityWorkSql("").slice(1, -1),
      },
    ],
  },
];

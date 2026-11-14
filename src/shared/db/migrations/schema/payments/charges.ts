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
import { refundAuthorityWorkCondition } from "#payment/refund-authority-lifecycle.ts";
import { madeAndTouched, ownerEncryptedColumn } from "./columns.ts";
import { sql } from "#db/sql.ts";

/** Rules the database can prove without understanding the whole state machine. */
const ABOUT_THE_CHARGE = [
  sql`provider IN ('stripe', 'square', 'sumup')`,
  sql`reference_index <> ''`,
  sql`capability IN ('keyed', 'keyless')`,
  sql`captured_amount >= 0`,
  sql`refunded_amount >= 0`,
  sql`length(currency) = 3 AND currency = upper(currency)`,
  sql`json_valid(refund_state)`,
  sql`json_type(refund_state) = 'object'`,
  sql`refund_state_name IN ('ready', 'send_armed', 'observing', 'completed', 'needs_owner_choice', 'needs_provider_check')`,
  sql`refund_local_state IN ('not_due', 'due', 'recorded')`,
  sql`json_type(refund_state, '$.kind') IS 'text'`,
  sql`json_type(refund_state, '$.request.capability') IS 'text'`,
  sql`json_type(refund_state, '$.local.kind') IS 'text'`,
  sql`json_type(refund_state, '$.nextActionAt') IS NOT NULL`,
  sql`json_extract(refund_state, '$.kind') = refund_state_name`,
  sql`json_extract(refund_state, '$.request.capability') = capability`,
  sql`json_extract(refund_state, '$.local.kind') = refund_local_state`,
  sql`json_extract(refund_state, '$.nextActionAt') IS next_refund_action_at`,
  sql`refund_revision >= 1`,
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
        where: sql`next_refund_action_at IS NOT NULL`,
      },
      {
        columns: ["id"],
        name: "idx_payment_charges_refund_state",
        where: refundAuthorityWorkCondition(""),
      },
    ],
  },
];

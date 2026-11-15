/** Durable payment aggregate: sessions, refundable charge legs, and cases. */

import type { NamedTable } from "#db/migrations/schema/types.ts";
import { paymentCaseTable } from "./cases.ts";
import { paymentChargeTable } from "./charges.ts";
import { paymentCompletionDeliveriesTable } from "./completion-deliveries.ts";
import { paymentCompletionEffectsTable } from "./completion-effects.ts";
import { paymentCaseDecisionTable } from "./decisions.ts";
import {
  refundConfirmationReferenceTable,
  refundConfirmationTable,
} from "./refund-confirmations.ts";
import { paymentSessionTable } from "./sessions.ts";

export const paymentTables = [
  paymentSessionTable,
  paymentCompletionEffectsTable,
  paymentCompletionDeliveriesTable,
  paymentChargeTable,
  paymentCaseTable,
  paymentCaseDecisionTable,
  refundConfirmationTable,
  refundConfirmationReferenceTable,
] as const satisfies readonly NamedTable[];

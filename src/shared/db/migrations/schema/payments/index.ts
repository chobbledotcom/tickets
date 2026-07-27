/** Durable payment aggregate: sessions, refundable charge legs, and cases. */

import type { Table } from "#shared/db/migrations/schema/types.ts";
import { paymentCaseTable } from "./cases.ts";
import { paymentChargeTable } from "./charges.ts";
import { paymentCompletionDeliveriesTable } from "./completion-deliveries.ts";
import { paymentCompletionEffectsTable } from "./completion-effects.ts";
import { paymentCaseDecisionTable } from "./decisions.ts";
import { paymentSessionTable } from "./sessions.ts";

export const paymentTables: [name: string, table: Table][] = [
  paymentSessionTable,
  paymentCompletionEffectsTable,
  paymentCompletionDeliveriesTable,
  paymentChargeTable,
  paymentCaseTable,
  paymentCaseDecisionTable,
];

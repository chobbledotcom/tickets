/** The migrations of 2026-08 onward, in run order. Part two of the registry
 * (see registry.ts). */
import { entry, type MigrationRegistryEntry } from "./registry-load.ts";

/* jscpd:ignore-start -- one loader line per migration module, import-block-like by nature */
export const ENTRIES_RECENT: MigrationRegistryEntry[] = [
  entry(
    "2026-08-04_login_attempt_stamp",
    () => import("./2026-08-04_login_attempt_stamp.ts"),
  ),
  // Everything the durable refund authority needs, in one migration. It drops
  // the dormant payment-record tables before the declarative apply reaches
  // them: this release redefines those tables, and the apply can only ADD
  // COLUMN to a table that already exists — which SQLite refuses for the new
  // PRIMARY KEY. Splitting this work apart is what let an upgrade break, so
  // keep the drop and the apply in the same migration.
  entry(
    "2026-08-10_refund_authority_records",
    () => import("./2026-08-10_refund_authority_records.ts"),
  ),
  entry(
    "2026-08-18_sumup_recovery_state",
    () => import("./2026-08-18_sumup_recovery_state.ts"),
  ),
  // The per-order join the refunded projection reads: names the booking order
  // each refund leg reverses, backfilled over every stored refund leg.
  entry(
    "2026-09-11_refund_order_link",
    () => import("./2026-09-11_refund_order_link.ts"),
  ),
  entry(
    "2026-09-14_group_show_hidden_listings",
    () => import("./2026-09-14_group_show_hidden_listings.ts"),
  ),
];
/* jscpd:ignore-end */

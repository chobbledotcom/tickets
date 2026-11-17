// effects: pure
/** The booking columns that an attendee merge copies to the target as they
 * are. */

import { pick } from "@std/collections";
import type { ListingAttendeeRow } from "#db/attendee-types.ts";

/**
 * The stored columns that the copy keeps. The caller sets the check-in
 * itself. The ledger projects the payment and the refund. A read can add
 * computed columns to the row, so the copy names each stored column.
 *
 * - The package group keeps package display and privacy on the copy.
 * - `ledger_event_group` stays, because the ledger repoint keeps the group of
 *   each leg.
 * - The subscription plan stays with its booking.
 */
/* jscpd:ignore-start -- a list of strings, not code */
const COPIED_COLUMNS = [
  "attachment_downloads",
  "end_at",
  "ledger_event_group",
  "listing_id",
  "order_token",
  "package_group_id",
  "parent_listing_id",
  "quantity",
  "recurring_interval",
  "recurring_price",
  "recurring_tax",
  "start_at",
  "subscription_id",
  "subscription_status",
] as const satisfies readonly Exclude<
  keyof ListingAttendeeRow,
  "checked_in" | "price_paid" | "refunded"
>[];
/* jscpd:ignore-end */

export const copiedBookingColumns = (booking: ListingAttendeeRow) =>
  pick(booking, COPIED_COLUMNS);

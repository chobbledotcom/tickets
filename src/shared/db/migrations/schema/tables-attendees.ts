/** Attendee, booking, payment, and activity tables. */

import { ATTENDEE_KIND, SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import type { Table } from "./types.ts";

export const attendeeTables: [name: string, table: Table][] = [
  [
    "attendee_statuses",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
        ["name", "TEXT NOT NULL"],
        ["is_public_default", "INTEGER NOT NULL DEFAULT 0"],
        ["is_paid_default", "INTEGER NOT NULL DEFAULT 0"],
        ["is_reservation", "INTEGER NOT NULL DEFAULT 0"],
        ["reservation_amount", "TEXT NOT NULL DEFAULT '0'"],
      ],
      indexes: [
        {
          columns: ["sort_order"],
          name: "idx_attendee_statuses_sort_order",
        },
      ],
    },
  ],

  [
    "attendees",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["created", "TEXT NOT NULL"],
        [
          "kind",
          `TEXT NOT NULL DEFAULT '${ATTENDEE_KIND}' CHECK (kind IN ('${ATTENDEE_KIND}', '${SERVICING_KIND}'))`,
        ],
        ["checked_in", "TEXT NOT NULL DEFAULT ''"],
        ["ticket_token_index", "TEXT"],
        ["pii_blob", "TEXT NOT NULL DEFAULT ''"],
        ["status_id", "INTEGER DEFAULT NULL"],
        ["split_logistics_agents", "INTEGER NOT NULL DEFAULT 0"],
        // HMAC blind-index of the attendee's phone, populated lazily the first
        // time an admin texts them, so inbound SMS replies can be matched back
        // to the attendee without storing the number in the clear.
        ["phone_index", "TEXT NOT NULL DEFAULT ''"],
      ],
      indexes: [
        {
          columns: ["kind"],
          name: "idx_attendees_kind",
        },
        {
          columns: ["ticket_token_index"],
          name: "idx_attendees_ticket_token_index",
          unique: true,
        },
        {
          columns: ["status_id"],
          name: "idx_attendees_status_id",
        },
        {
          columns: ["phone_index"],
          name: "idx_attendees_phone_index",
        },
      ],
    },
  ],

  [
    "listing_attendees",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["listing_id", "INTEGER NOT NULL"],
        ["attendee_id", "INTEGER NOT NULL"],
        ["start_at", "TEXT DEFAULT NULL"],
        ["end_at", "TEXT DEFAULT NULL"],
        ["quantity", "INTEGER NOT NULL DEFAULT 1"],
        ["checked_in", "INTEGER NOT NULL DEFAULT 0"],
        // The ledger event group of the booking order this row belongs to, so a
        // per-row money projection (amount paid) can find exactly this booking's
        // legs even when an attendee holds several orders for one listing. Set on
        // booking creation and by the backfill; '' for rows with no ledger legs.
        ["ledger_event_group", "TEXT NOT NULL DEFAULT ''"],
        ["attachment_downloads", "INTEGER NOT NULL DEFAULT 0"],
        ["start_agent_id", "INTEGER DEFAULT NULL"],
        ["end_agent_id", "INTEGER DEFAULT NULL"],
        ["start_time", "TEXT NOT NULL DEFAULT ''"],
        ["end_time", "TEXT NOT NULL DEFAULT ''"],
        ["start_done", "INTEGER NOT NULL DEFAULT 0"],
        ["end_done", "INTEGER NOT NULL DEFAULT 0"],
        // A per-booking token shared by every attendee row created in one
        // checkout (a parent and its chosen children), so the admin can group an
        // order's rows. Empty for legacy rows and bookings with no parent.
        ["order_token", "TEXT NOT NULL DEFAULT ''"],
        // For a folded child row, the parent listing the buyer chose it under
        // (0 = not a folded child). A child summed across two parents records the
        // first — the common case is one parent → one child.
        ["parent_listing_id", "INTEGER NOT NULL DEFAULT 0"],
        // The package group this order belongs to (0 = not a package), stamped on
        // every booking row of one package checkout like order_token. Tickets and
        // confirmation emails group the order's lines under the package by this
        // persisted id, so a standalone order of the same listings is not
        // mistaken for the package by membership equality.
        ["package_group_id", "INTEGER NOT NULL DEFAULT 0"],
      ],
      // FKs omitted — libsql's FK enforcement causes issues during table
      // recreation migrations. Referential integrity is enforced by application
      // logic and the indexes below.
      indexes: [
        {
          // Includes parent_listing_id so the SAME child chosen under two
          // parents is two distinct booking rows (one per parent, faithful
          // provenance) rather than colliding into one folded row, AND
          // package_group_id so the same listing booked through two
          // overlapping packages (or a package plus its own standalone row) in
          // one order keeps one faithful row per path. A plain line has 0 for
          // both, so its slot is unchanged.
          columns: [
            "listing_id",
            "attendee_id",
            "start_at",
            "parent_listing_id",
            "package_group_id",
          ],
          name: "idx_listing_attendees_listing_attendee_start",
          unique: true,
        },
        {
          columns: ["attendee_id", "listing_id"],
          name: "idx_listing_attendees_attendee_listing",
        },
        // Overlap queries filter `start_at < dayEnd AND end_at > dayStart`
        // where both bounds are in the future. With end_at first, the index
        // range scan skips historical rows (end_at in the past) instead of
        // visiting every row ever booked and rejecting on the residual
        // predicate — per-day capacity SUMs stay O(active rows).
        {
          columns: ["listing_id", "end_at", "start_at"],
          name: "idx_listing_attendees_listing_end_start",
        },
        // The Logistics tab's Other Attendees list overlaps a date window
        // across ALL listings, so the listing_id-first index above can't serve
        // it. Same end_at-first shape for the same reason: the range scan
        // skips historical rows instead of walking every booking ever made.
        {
          columns: ["end_at", "start_at"],
          name: "idx_listing_attendees_end_start",
        },
        // The ledger-replay owner lookup (attendeeIdByLedgerEventGroup) seeks a
        // booking by its event group: WHERE ledger_event_group = ?. Without this
        // it full-scans every row ever booked; the '' default rows (no ledger
        // legs) collapse to one key, so a real group still seeks straight to it.
        {
          columns: ["ledger_event_group"],
          name: "idx_listing_attendees_ledger_event_group",
        },
      ],
    },
  ],

  [
    "activity_log",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["created", "TEXT NOT NULL"],
        ["listing_id", "INTEGER"],
        ["message", "TEXT NOT NULL"],
        ["attendee_id", "INTEGER"],
      ],
      indexes: [
        {
          columns: ["attendee_id"],
          name: "idx_activity_log_attendee_id",
        },
        // Per-listing log reads filter on listing_id and order by id DESC.
        // Because id is AUTOINCREMENT (== rowid), this index already orders its
        // entries by (listing_id, id), so the filter + newest-first scan is an
        // index range scan with no sort — instead of scanning the whole
        // (unbounded) log table on every admin listing page view.
        {
          columns: ["listing_id"],
          name: "idx_activity_log_listing_id",
        },
      ],
    },
  ],
];

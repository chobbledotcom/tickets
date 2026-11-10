/** Attendee, booking, payment, and activity tables. */

import { ATTENDEE_KIND, SERVICING_KIND } from "#db/attendees/kind.ts";
import {
  attendeeIdColumn,
  datedRowColumns,
  sortOrderColumn,
  statefulColumns,
} from "./columns.ts";
import {
  checked,
  defaulted,
  requiredTextKey,
  rowId,
  text,
  textKey,
  textOrNull,
  textStartingAtNull,
  textStartingBlank,
  wholeNumber,
  wholeNumberOrNull,
  wholeNumberStartingAtNull,
  wholeNumberStartingAtOne,
  wholeNumberStartingAtZero,
} from "./scalar-columns.ts";
import type { Table } from "./types.ts";

export const attendeeTables: [name: string, table: Table][] = [
  [
    "attendee_statuses",
    {
      columns: [
        ["id", rowId],
        sortOrderColumn,
        ["name", text],
        ["is_public_default", wholeNumberStartingAtZero],
        ["is_paid_default", wholeNumberStartingAtZero],
        ["is_reservation", wholeNumberStartingAtZero],
        ["reservation_amount", defaulted(text, "0")],
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
        ...datedRowColumns,
        [
          "kind",
          checked(`kind IN ('${ATTENDEE_KIND}', '${SERVICING_KIND}')`)(
            defaulted(text, ATTENDEE_KIND),
          ),
        ],
        ["checked_in", textStartingBlank],
        ["ticket_token_index", textOrNull],
        ["pii_blob", textStartingBlank],
        // NULL means unqualified history and remains unavailable to bulk
        // refunds. Empty proves PII has no payment id. Otherwise this names
        // the canonical payment row that proves the PII payment id.
        ["pii_payment_session_id", textOrNull],
        ["status_id", wholeNumberStartingAtNull],
        ["split_logistics_agents", wholeNumberStartingAtZero],
        // Whether a notification send is owed for this booking, and who the
        // booking came from: 0 none, 1 booked online, 2 added by an admin.
        // An owed send that never got through keeps the flag up, so the
        // admin sees it.
        ["email_pending", wholeNumberStartingAtZero],
        ["webhooks_pending", wholeNumberStartingAtZero],
        // HMAC blind-index of the attendee's phone. The index is filled
        // lazily the first time an admin texts them, so inbound SMS replies
        // can be matched back to the attendee. The number is never stored
        // in the clear.
        ["phone_index", textStartingBlank],
      ],
      indexes: [
        {
          columns: ["kind"],
          name: "idx_attendees_kind",
        },
        {
          columns: ["kind"],
          name: "idx_attendees_pending_flags",
          where: "email_pending > 0 OR webhooks_pending > 0",
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
        ["id", rowId],
        ["listing_id", wholeNumber],
        attendeeIdColumn,
        ["start_at", textStartingAtNull],
        ["end_at", textStartingAtNull],
        ["quantity", wholeNumberStartingAtOne],
        // How many of this row's quantity the doors admitted: 0..quantity. A
        // quantity 0 ghost row always stores 0, and the admit write caps at
        // quantity so concurrent doors cannot pass it.
        ["checked_in", wholeNumberStartingAtZero],
        // The ledger event group of the booking order this row belongs to, so a
        // per-row money projection (amount paid) can find exactly this booking's
        // legs even when an attendee holds several orders for one listing. Set on
        // booking creation and by the backfill; '' for rows with no ledger legs.
        ["ledger_event_group", textStartingBlank],
        ["attachment_downloads", wholeNumberStartingAtZero],
        ["start_agent_id", wholeNumberStartingAtNull],
        ["end_agent_id", wholeNumberStartingAtNull],
        ["start_time", textStartingBlank],
        ["end_time", textStartingBlank],
        ["start_done", wholeNumberStartingAtZero],
        ["end_done", wholeNumberStartingAtZero],
        // A per-booking token shared by every attendee row created in one
        // checkout (a parent and its chosen children), so the admin can group an
        // order's rows. Empty for legacy rows and bookings with no parent.
        ["order_token", textStartingBlank],
        // For a folded child row, the parent listing the buyer chose it under
        // (0 = not a folded child). A child summed across two parents records the
        // first — the common case is one parent → one child.
        ["parent_listing_id", wholeNumberStartingAtZero],
        // The package group this order belongs to (0 = not a package), stamped on
        // every booking row of one package checkout like order_token. Tickets and
        // confirmation emails group the order's lines under the package by this
        // persisted id, so a standalone order of the same listings is not
        // mistaken for the package by membership equality.
        ["package_group_id", wholeNumberStartingAtZero],
        // The plan Stripe reported when this person subscribed, so a later
        // listing edit never changes it. recurring_price is minor units for
        // the whole quantity, VAT included, and 0 means no subscription.
        ["recurring_price", wholeNumberStartingAtZero],
        ["recurring_tax", wholeNumberStartingAtZero],
        ["recurring_interval", textStartingBlank],
        ["subscription_id", textStartingBlank],
        ["subscription_status", textStartingBlank],
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
    "checkout_stages",
    {
      columns: [
        ["payment_session_id", requiredTextKey],
        attendeeIdColumn,
        ["provider", text],
        ["ticket_tokens", text],
        ...statefulColumns,
      ],
      indexes: [
        {
          columns: ["attendee_id"],
          name: "idx_checkout_stages_attendee_id",
          unique: true,
        },
        {
          columns: ["state", "created_at"],
          name: "idx_checkout_stages_state_created_at",
        },
      ],
    },
  ],

  [
    "processed_payments",
    {
      columns: [
        ["payment_session_id", textKey],
        ["attendee_id", wholeNumberOrNull],
        ["processed_at", text],
        ["ticket_tokens", textStartingBlank],
        ["failure_data", textStartingBlank],
        ["payment_reference", textStartingBlank],
        ["provider_refunded_at", textStartingBlank],
        // Two payment-state columns a claim depends on:
        // the plain-text mirror of live work that SQL-only consumers (pruning,
        // orphan selection) can see without decrypting, and a blind one-way
        // index of the reference's identity so a claim can spot another row
        // holding the same provider money. Validated current writes store both
        // with the reference. Historical blank rows make refunds fail closed
        // until the bounded owner-authenticated M11 copy.
        ["protected_state", textStartingBlank],
        ["payment_reference_index", textStartingBlank],
      ],
      // Admin rosters, exports, and refund-all candidate loading look up the
      // retained charge references for a listing's attendees
      // (attendee_id IN (...) AND payment_reference != ''). Leading with
      // attendee_id and covering payment_reference turns that into an index
      // range scan instead of a full scan of every retained payment row.
      indexes: [
        {
          columns: ["attendee_id", "payment_reference"],
          name: "idx_processed_payments_attendee_id",
        },
        // Deliberately NOT unique: two real rows can carry one legacy
        // reference (the F21 duplicates this column exposes), and anchor-row
        // mints get their uniqueness from a primary key derived from this
        // value instead.
        {
          columns: ["payment_reference_index"],
          name: "idx_processed_payments_reference_index",
        },
        {
          columns: ["attendee_id"],
          name: "idx_processed_payments_protected_attendee",
          where: "protected_state != ''",
        },
      ],
      // FK declarations removed — libsql's FK enforcement breaks table
      // recreation migrations (PRAGMA foreign_keys is connection-scoped and
      // doesn't persist into batch operations on remote databases).
      // Referential integrity is enforced by application logic.
    },
  ],

  // The door's replay ledger for queued offline check-ins. One row per
  // delivery a hash admission claimed, keyed by the operation id and the
  // token digest together. The same pair that retries is one retry. The
  // same id beside another ticket's digest is another delivery, and it
  // claims its own row. A row keeps the listings its delivery admitted and
  // how many places that admission took. A retry answers the tier and the
  // quantity the first send put in. No ticket token and no guest detail
  // rests here. The digest is the delivery's own identity, and the
  // retention window bounds its stay.
  [
    "processed_scan_operations",
    {
      columns: [
        ["operation_id", text],
        ["token_hash", text],
        ["listing_ids", text],
        ["quantity", wholeNumber],
        ["created", text],
      ],
      indexes: [
        {
          columns: ["operation_id", "token_hash"],
          name: "idx_processed_scan_operations_delivery",
          unique: true,
        },
      ],
    },
  ],

  [
    "activity_log",
    {
      columns: [
        ...datedRowColumns,
        ["listing_id", wholeNumberOrNull],
        ["message", text],
        ["attendee_id", wholeNumberOrNull],
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

  [
    // SumUp checkouts can't carry arbitrary metadata through the provider
    // (unlike Stripe sessions / Square orders), so booking metadata is staged
    // here between checkout creation and payment completion, then read back on
    // webhook/redirect. The blob contains PII, so it is encrypted with a
    // per-row data key wrapped by the checkout reference — the plaintext
    // reference never rests in this DB (it arrives at runtime from the
    // redirect URL or SumUp's API), so a DB dump alone cannot decrypt these
    // rows. Lookup is by HMAC of the reference, like ticket_token_index.
    // Rows are short-lived: pruned after PRUNE_SUMUP_RETENTION_HOURS.
    // wrapped_key has a DEFAULT so ADD COLUMN self-heals pre-release dev DBs
    // that created the earlier plaintext shape of this table.
    "sumup_checkouts",
    {
      columns: [
        ["reference_index", textKey],
        ["wrapped_key", textStartingBlank],
        ["metadata", text],
        ["sumup_id", textStartingBlank],
        ["created_at", text],
        // What happened to this checkout, and when to ask SumUp again. The
        // words and the moves between them are declared in
        // shared/payment/sumup-recovery-machine-spec.ts; a NULL check time
        // means nothing will ask again, which is true of a row that has no
        // checkout id yet and of one that reached a definitive answer.
        ["recovery_state", defaulted(text, "staged")],
        ["next_check_at", textOrNull],
      ],
      indexes: [
        {
          columns: ["sumup_id"],
          name: "idx_sumup_checkouts_sumup_id",
        },
        {
          columns: ["recovery_state", "next_check_at"],
          name: "idx_sumup_checkouts_next_check",
        },
      ],
    },
  ],

  [
    // Free-text answers staged between checkout creation and payment
    // completion, so the buyer's confirmation email can show what they typed
    // without spending the owner key at webhook time. Sealed with
    // DB_ENCRYPTION_KEY and keyed by the HMAC of the session id: for SumUp
    // the session id is the checkout reference, which must never rest in this
    // database (see sumup_checkouts for why). The row is deleted the moment
    // the completion reads it. Survivors prune on the payments clock, which
    // covers provider retry windows, and not before `link_ends_at`: a Square
    // row also waits for its handle row to be gone, or for Square's own
    // 180-day page lifetime to pass. The column is null for checkouts that
    // end within days.
    "checkout_pending_answers",
    {
      columns: [
        ["session_index", textKey],
        ["sealed", text],
        ["created_at", text],
        ["link_ends_at", textOrNull],
      ],
    },
  ],

  [
    // One cancel handle per unpaid Square checkout: the payment link id,
    // sealed with DB_ENCRYPTION_KEY and keyed by the HMAC of the session id,
    // exactly like checkout_pending_answers. The row exists only while its
    // link can still take payment — the expiry task deletes it the moment
    // Square proves the link ended, was already gone, or was paid, and the
    // completion deletes it when a payment lands. The state words and the
    // moves between them are declared in
    // shared/payment/square-link-end-machine-spec.ts.
    "square_link_ends",
    {
      columns: [
        ["session_index", textKey],
        ["sealed_handle", text],
        ["link_ends_at", text],
        ["next_attempt_at", text],
        ...statefulColumns,
      ],
      indexes: [
        {
          columns: ["state", "next_attempt_at"],
          name: "idx_square_link_ends_next_attempt",
        },
      ],
    },
  ],
];

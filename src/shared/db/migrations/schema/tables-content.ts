/** Content, communications, ledger, and page tables. */

import type { Table } from "./types.ts";

export const contentTables: [name: string, table: Table][] = [
  [
    // Per-contact marketing preferences, contact history, and visit counts,
    // keyed by an opaque HMAC blind index. Public checkout/unsubscribe paths can
    // read the plaintext operational scalars; richer outreach stats stay in the
    // owner-keypair-encrypted stats_blob.
    "contact_preferences",
    {
      columns: [
        ["contact_hash", "TEXT PRIMARY KEY"],
        ["unsubscribed", "INTEGER NOT NULL DEFAULT 0"],
        ["visits", "INTEGER NOT NULL DEFAULT 0"],
        ["public_booking_count", "INTEGER NOT NULL DEFAULT 0"],
        ["admin_booking_count", "INTEGER NOT NULL DEFAULT 0"],
        ["stats_blob", "TEXT NOT NULL DEFAULT ''"],
        ["attendee_tokens_blob", "TEXT NOT NULL DEFAULT ''"],
        ["last_activity", "INTEGER NOT NULL DEFAULT 0"],
      ],
      indexes: [
        {
          columns: ["unsubscribed"],
          name: "idx_contact_prefs_unsubscribed",
        },
        {
          columns: ["last_activity"],
          name: "idx_contact_prefs_last_activity",
        },
      ],
    },
  ],

  [
    // Reusable email templates — subject and body stored as owner-keypair-
    // encrypted blobs so the operator cannot read content without the owner's
    // password. Encryption/decryption is handled at the route layer (same
    // approach as bulk_email_draft in settings).
    "email_templates",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["subject", "TEXT NOT NULL"],
        ["body", "TEXT NOT NULL"],
      ],
    },
  ],

  [
    // Lean, PII-free map from the gateway's message id to the attendee it was
    // sent to, so delivery/failure webhooks can be logged against the right
    // attendee. Message content and recipient numbers live only in the
    // (encrypted) activity log — never here. Rows are deleted on a terminal
    // status event and pruned by age as a backstop.
    "sms_messages",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["attendee_id", "INTEGER NOT NULL"],
        ["listing_id", "INTEGER NOT NULL"],
        ["provider_id", "TEXT NOT NULL"],
        ["created", "TEXT NOT NULL"],
      ],
      indexes: [
        { columns: ["provider_id"], name: "idx_sms_messages_provider_id" },
        { columns: ["created"], name: "idx_sms_messages_created" },
      ],
    },
  ],

  [
    // Short-lived inbound idempotency ledger keyed by the gateway's stable
    // inbound id. Contains no SMS content or sender number.
    "processed_sms_inbound",
    {
      columns: [
        ["webhook_id", "TEXT PRIMARY KEY"],
        ["created", "TEXT NOT NULL"],
      ],
      indexes: [
        { columns: ["created"], name: "idx_processed_sms_inbound_created" },
      ],
    },
  ],

  [
    // Double-entry ledger: each row moves a positive `amount` from a
    // (source_type, source_id) account to a (dest_type, dest_id) account at
    // occurred_at (business time). Normal checkout/refund flows post immutable
    // rows; owner-only maintenance can edit/delete rows explicitly. Balances are
    // always derived. PII- and provider-id-free: `reference` is an opaque HMAC,
    // and any memo that could carry PII is owner-key encrypted by the host
    // before it reaches the column. No FKs, so erasing an attendee never
    // cascades here.
    "transfers",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["source_type", "TEXT NOT NULL"],
        ["source_id", "TEXT NOT NULL"],
        ["dest_type", "TEXT NOT NULL"],
        ["dest_id", "TEXT NOT NULL"],
        ["amount", "INTEGER NOT NULL CHECK (amount > 0)"],
        // Epoch-millis: the indexed time column then sorts/ranges chronologically
        // with integer comparisons at high row counts. The host stores any ISO
        // instant as its epoch-millis and reads it back canonical (see
        // shared/validation/timestamp.ts).
        ["occurred_at", "INTEGER NOT NULL"],
        ["recorded_at", "INTEGER NOT NULL"],
        ["reference", "TEXT NOT NULL"],
        ["event_group", "TEXT NOT NULL"],
        ["kind", "TEXT NOT NULL DEFAULT ''"],
        ["memo", "TEXT NOT NULL DEFAULT ''"],
        ["reverses_id", "INTEGER DEFAULT NULL"],
        ["posted_by", "TEXT NOT NULL DEFAULT 'system'"],
      ],
      indexes: [
        // Idempotency: one row per opaque reference (the ON CONFLICT target).
        {
          columns: ["reference"],
          name: "idx_transfers_reference",
          unique: true,
        },
        // Balance projections scan by account.
        { columns: ["source_type", "source_id"], name: "idx_transfers_source" },
        { columns: ["dest_type", "dest_id"], name: "idx_transfers_dest" },
        // Period reports and statement ordering.
        { columns: ["occurred_at"], name: "idx_transfers_occurred_at" },
        // Order-scoped guards/refunds group by event.
        { columns: ["event_group"], name: "idx_transfers_event_group" },
        // At most one void per original: a non-NULL reverses_id is unique
        // (SQLite treats NULLs as distinct, so ordinary transfers are free).
        {
          columns: ["reverses_id"],
          name: "idx_transfers_reverses_id",
          unique: true,
        },
      ],
    },
  ],

  [
    // First-class service-cost records: one row per `recordServiceCost` call,
    // linking the cost's ledger leg to the servicing event that recorded it.
    // The transfers ledger is append-only and carries no servicing-event id on
    // its legs, so this table is what scopes `/admin/servicing/:id`'s cost list
    // to one event. `transfer_id` is the original `service_cost` leg; edits post
    // adjustment legs keyed to it by memo, and `getServicingCosts` derives each
    // record's current amount from the leg + its adjustments.
    "service_costs",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["servicing_attendee_id", "INTEGER NOT NULL"],
        ["listing_id", "INTEGER NOT NULL"],
        ["transfer_id", "INTEGER NOT NULL"],
        ["occurred_at", "TEXT NOT NULL"],
        ["memo", "TEXT NOT NULL DEFAULT ''"],
        ["created", "TEXT NOT NULL"],
      ],
      indexes: [
        {
          columns: ["servicing_attendee_id"],
          name: "idx_service_costs_servicing",
        },
        {
          columns: ["transfer_id"],
          name: "idx_service_costs_transfer",
          unique: true,
        },
      ],
    },
  ],

  [
    // User-created content pages. All free text is stored encrypted;
    // slug_index is the plaintext HMAC blind index. sort_order positions the
    // page among root-level pages.
    "site_pages",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["slug", "TEXT NOT NULL"],
        ["slug_index", "TEXT NOT NULL"],
        ["name", "TEXT NOT NULL"],
        ["meta_title", "TEXT NOT NULL DEFAULT ''"],
        ["meta_description", "TEXT NOT NULL DEFAULT ''"],
        ["content", "TEXT NOT NULL DEFAULT ''"],
        ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
      ],
      indexes: [
        {
          columns: ["slug_index"],
          name: "idx_site_pages_slug_index",
          unique: true,
        },
      ],
    },
  ],

  [
    // News posts shown on the public /news page. All free text (including the
    // slug) is stored encrypted; `created` stays plaintext (like
    // listings.created) so the newest-first ordering and the RSS pubDate never
    // need a scan-and-decrypt. `slug_index` is the plaintext HMAC blind index
    // of the `/news/:slug` permalink, so a post loads by slug without decrypting.
    "news_posts",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["created", "TEXT NOT NULL"],
        ["slug", "TEXT NOT NULL DEFAULT ''"],
        ["slug_index", "TEXT NOT NULL DEFAULT ''"],
        ["name", "TEXT NOT NULL"],
        ["meta_title", "TEXT NOT NULL DEFAULT ''"],
        ["meta_description", "TEXT NOT NULL DEFAULT ''"],
        ["snippet", "TEXT NOT NULL DEFAULT ''"],
        ["content", "TEXT NOT NULL DEFAULT ''"],
      ],
      indexes: [
        {
          columns: ["created"],
          name: "idx_news_posts_created",
        },
        {
          columns: ["slug_index"],
          name: "idx_news_posts_slug_index",
          unique: true,
        },
      ],
    },
  ],

  [
    // Ordered membership edges: a listing/group/page sits inside a page. The
    // single-parent invariant for `page` items is enforced in application code
    // (the schema can't express a partial-unique index).
    "site_page_items",
    {
      columns: [
        ["page_id", "INTEGER NOT NULL"],
        ["item_type", "TEXT NOT NULL"],
        ["item_id", "INTEGER NOT NULL"],
        ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
      ],
      indexes: [
        {
          columns: ["page_id", "sort_order"],
          name: "idx_site_page_items_page",
        },
        {
          columns: ["page_id", "item_type", "item_id"],
          name: "idx_site_page_items_key",
          unique: true,
        },
        {
          columns: ["item_type", "item_id"],
          name: "idx_site_page_items_child_page",
        },
      ],
    },
  ],

  [
    // Address-lookup result cache. search_index is the HMAC blind index of
    // "provider:normalised-search" and results is the encrypted JSON array of
    // address lines, so neither the searched value nor the returned addresses
    // are readable from a database dump. Rows expire after ADDRESS_CACHE_DAYS:
    // reads filter on the cutoff and the prune task deletes past it.
    "address_cache",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["search_index", "TEXT NOT NULL"],
        ["results", "TEXT NOT NULL"],
        ["created", "TEXT NOT NULL"],
      ],
      indexes: [
        {
          columns: ["search_index"],
          name: "idx_address_cache_search_index",
          unique: true,
        },
        { columns: ["created"], name: "idx_address_cache_created" },
      ],
    },
  ],
];

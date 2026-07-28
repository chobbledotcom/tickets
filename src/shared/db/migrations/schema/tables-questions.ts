/** Form tables: questions, answers, attributes, built sites, notes. */

import { NOTE_ENTITIES } from "#shared/db/notes/target.ts";
import { createdColumn, sortOrderColumn } from "./scalar-columns.ts";
import type { Table } from "./types.ts";

/** The record kinds a note may be about, as a CHECK the database enforces. */
const noteEntityCheck = `entity_type IN (${NOTE_ENTITIES.map(
  (entity) => `'${entity}'`,
).join(", ")})`;

export const questionTables: [name: string, table: Table][] = [
  [
    "questions",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["text", "TEXT NOT NULL"],
        sortOrderColumn,
        [
          "display_type",
          "TEXT NOT NULL DEFAULT 'radio' CHECK (display_type IN ('radio', 'select', 'free_text'))",
        ],
        ["assign_all", "INTEGER NOT NULL DEFAULT 0"],
      ],
    },
  ],

  [
    "strings",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["text_index", "TEXT NOT NULL"],
        ["encrypted_text", "TEXT NOT NULL"],
        ["used_count", "INTEGER NOT NULL DEFAULT 0"],
        ["created", "TEXT NOT NULL DEFAULT ''"],
      ],
      indexes: [
        {
          columns: ["text_index"],
          name: "idx_strings_text_index",
          unique: true,
        },
      ],
    },
  ],

  [
    "answers",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["question_id", "INTEGER NOT NULL"],
        ["text", "TEXT NOT NULL"],
        sortOrderColumn,
        // The price modifier this answer triggers (an "answer"-trigger
        // modifier), or NULL for an answer with no price effect. Many answers
        // may point at one "pricing tier" modifier; an answer has at most one.
        ["modifier_id", "INTEGER"],
        // Precomputed COUNT of attendee_answers rows for this answer,
        // maintained by the ANSWER_AGGREGATE_TRIGGERS so the question/answer
        // admin pages report how many times the answer was chosen without
        // scanning attendee_answers. Owner-editable on the answer edit page;
        // the recalculate flow rebuilds it from attendee_answers when it drifts.
        ["times_selected", "INTEGER NOT NULL DEFAULT 0"],
        // Deactivated answers (active = 0) are hidden on the public booking
        // form but still shown on the admin edit form for an attendee who
        // already selected them, so historic answers are never silently lost.
        ["active", "INTEGER NOT NULL DEFAULT 1"],
      ],
      indexes: [
        { columns: ["question_id"], name: "idx_answers_question_id" },
        { columns: ["modifier_id"], name: "idx_answers_modifier_id" },
      ],
    },
  ],

  [
    "listing_questions",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["listing_id", "INTEGER NOT NULL"],
        ["question_id", "INTEGER NOT NULL"],
        sortOrderColumn,
      ],
      indexes: [
        { columns: ["listing_id"], name: "idx_listing_questions_listing_id" },
        {
          columns: ["listing_id", "question_id"],
          name: "idx_listing_questions_unique",
          unique: true,
        },
      ],
    },
  ],

  [
    // Reusable public listing attributes. The attribute name and option text are
    // encrypted like listing descriptions and custom questions; filtering uses
    // option ids, so no plaintext index is needed.
    "attributes",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["name", "TEXT NOT NULL"],
        sortOrderColumn,
      ],
      indexes: [{ columns: ["sort_order"], name: "idx_attributes_sort_order" }],
    },
  ],

  [
    "attribute_options",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["attribute_id", "INTEGER NOT NULL"],
        ["text", "TEXT NOT NULL"],
        sortOrderColumn,
      ],
      indexes: [
        { columns: ["attribute_id"], name: "idx_attribute_options_attribute" },
      ],
    },
  ],

  [
    // A selected option on a listing. The option points to its attribute, so the
    // listing does not need a separate attribute row: one path handles one or
    // many selected options.
    "listing_attribute_options",
    {
      columns: [
        ["listing_id", "INTEGER NOT NULL"],
        ["option_id", "INTEGER NOT NULL"],
      ],
      indexes: [
        {
          columns: ["listing_id", "option_id"],
          name: "idx_listing_attribute_options_pair",
          unique: true,
        },
        {
          columns: ["option_id"],
          name: "idx_listing_attribute_options_option",
        },
      ],
    },
  ],

  [
    "built_sites",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["site_data", "TEXT NOT NULL"],
        ["assignable", "INTEGER NOT NULL DEFAULT 0"],
        ["assigned_attendee_id", "INTEGER DEFAULT NULL"],
        ["assigned_listing_id", "INTEGER DEFAULT NULL"],
        createdColumn,
        ["renewal_token_index", "TEXT DEFAULT NULL"],
        ["read_only_from", "TEXT NOT NULL DEFAULT ''"],
        ["site_data_revision", "INTEGER NOT NULL DEFAULT 0"],
        // Release channel this site opts into: 'alpha' takes every deploy,
        // 'beta' takes beta + release, 'release' only stable releases. The
        // upgrade workflow passes the tier it is publishing and the master
        // returns only the sites at that tier or more eager (see UPDATE_TIERS
        // in built-sites.ts). Operational metadata, not PII, so it lives outside
        // the encrypted site_data blob and stays SQL-filterable.
        [
          "updates",
          "TEXT NOT NULL DEFAULT 'release' CHECK (updates IN ('alpha', 'beta', 'release'))",
        ],
      ],
      indexes: [
        {
          columns: ["renewal_token_index"],
          name: "idx_built_sites_renewal_token_index",
          unique: true,
        },
      ],
    },
  ],

  [
    "attendee_answers",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["attendee_id", "INTEGER NOT NULL"],
        ["answer_id", "INTEGER"],
        ["question_id", "INTEGER"],
        ["string_id", "INTEGER"],
      ],
      indexes: [
        {
          columns: ["attendee_id"],
          name: "idx_attendee_answers_attendee_id",
        },
        { columns: ["answer_id"], name: "idx_attendee_answers_answer_id" },
        { columns: ["question_id"], name: "idx_attendee_answers_question_id" },
        { columns: ["string_id"], name: "idx_attendee_answers_string_id" },
        {
          columns: ["attendee_id", "answer_id"],
          name: "idx_attendee_answers_unique",
          unique: true,
        },
        {
          columns: ["attendee_id", "question_id"],
          name: "idx_attendee_string_answers_unique",
          unique: true,
        },
      ],
    },
  ],

  [
    // Notes the operator sees on a record, named by which kind of record they
    // are about (`entity_type`) and which one (`entity_id`). `note` is always
    // stored encrypted — a `system` note (auto-generated, e.g. the
    // refunded-but-stored booking warning) with the symmetric DB_ENCRYPTION_KEY
    // so a key-less system path can both write and read it back, an `owner` note
    // (operator-authored) with the owner public key so only the owner can read
    // it. System notes are kept PII-free by convention. No FKs — each record's
    // delete path prunes these rows explicitly.
    "system_notes",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        // The kinds come from NOTE_ENTITIES, so the stored values and the ones
        // the code accepts cannot drift apart.
        ["entity_type", `TEXT NOT NULL CHECK (${noteEntityCheck})`],
        ["entity_id", "INTEGER NOT NULL"],
        [
          "type",
          "TEXT NOT NULL DEFAULT 'system' CHECK (type IN ('system', 'owner'))",
        ],
        ["note", "TEXT NOT NULL"],
        createdColumn,
      ],
      indexes: [
        {
          columns: ["entity_type", "entity_id"],
          name: "idx_system_notes_entity",
        },
      ],
    },
  ],
];

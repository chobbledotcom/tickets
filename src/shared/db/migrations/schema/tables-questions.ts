/** Form tables: questions, answers, attributes, built sites, notes. */

import { UPDATE_TIERS } from "#db/built-sites/types.ts";
import { NOTE_ENTITIES } from "#db/notes/target.ts";
import { SYSTEM_NOTE_TYPES } from "#db/notes/types.ts";
import { QUESTION_DISPLAY_TYPES } from "#db/question-types.ts";
import { sql } from "#db/sql.ts";
import { attendeeIdColumn, sortOrderColumn } from "./columns.ts";
import {
  checked,
  defaulted,
  oneOf,
  rowId,
  text,
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

export const questionTables: [name: string, table: Table][] = [
  [
    "questions",
    {
      columns: [
        ["id", rowId],
        ["text", text],
        sortOrderColumn,
        [
          "display_type",
          oneOf(
            "display_type",
            QUESTION_DISPLAY_TYPES,
          )(defaulted(text, "radio")),
        ],
        ["assign_all", wholeNumberStartingAtZero],
      ],
    },
  ],

  [
    "strings",
    {
      columns: [
        ["id", rowId],
        ["text_index", text],
        ["encrypted_text", text],
        ["used_count", wholeNumberStartingAtZero],
        ["created", textStartingBlank],
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
        ["id", rowId],
        ["question_id", wholeNumber],
        ["text", text],
        sortOrderColumn,
        // The price modifier this answer triggers (an "answer"-trigger
        // modifier), or NULL for an answer with no price effect. Many answers
        // may point at one "pricing tier" modifier; an answer has at most one.
        ["modifier_id", wholeNumberOrNull],
        // Precomputed COUNT of attendee_answers rows for this answer,
        // maintained by the ANSWER_AGGREGATE_TRIGGERS so the question/answer
        // admin pages report how many times the answer was chosen without
        // scanning attendee_answers. Owner-editable on the answer edit page;
        // the recalculate flow rebuilds it from attendee_answers when it drifts.
        ["times_selected", wholeNumberStartingAtZero],
        // Deactivated answers (active = 0) are hidden on the public booking
        // form but still shown on the admin edit form for an attendee who
        // already selected them, so historic answers are never silently lost.
        ["active", wholeNumberStartingAtOne],
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
        ["id", rowId],
        ["listing_id", wholeNumber],
        ["question_id", wholeNumber],
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
      columns: [["id", rowId], ["name", text], sortOrderColumn],
      indexes: [{ columns: ["sort_order"], name: "idx_attributes_sort_order" }],
    },
  ],

  [
    "attribute_options",
    {
      columns: [
        ["id", rowId],
        ["attribute_id", wholeNumber],
        ["text", text],
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
        ["listing_id", wholeNumber],
        ["option_id", wholeNumber],
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
        ["id", rowId],
        ["site_data", text],
        ["assignable", wholeNumberStartingAtZero],
        ["assigned_attendee_id", wholeNumberStartingAtNull],
        ["assigned_listing_id", wholeNumberStartingAtNull],
        ["created", text],
        // Positive epoch milliseconds wait for completion. Negative values
        // own a provider operation, and zero is idle.
        ["database_key_rotation_started", wholeNumberStartingAtZero],
        ["renewal_token_index", textStartingAtNull],
        ["read_only_from", textStartingBlank],
        ["site_data_revision", wholeNumberStartingAtZero],
        // Release channel this site opts into: 'alpha' takes every deploy,
        // 'beta' takes beta + release, 'release' only stable releases. The
        // upgrade workflow passes the tier it is publishing and the master
        // returns only the sites at that tier or more eager (see UPDATE_TIERS
        // in built-sites.ts). Operational metadata, not PII, so it lives outside
        // the encrypted site_data blob and stays SQL-filterable.
        ["updates", oneOf("updates", UPDATE_TIERS)(defaulted(text, "release"))],
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
    // The questions a booking asked and the answer to each, as the booking
    // saved them. Admin edits change attendee_answers only, so the two compare.
    // The texts are copied ciphertext, not links, so a later question, answer,
    // or string delete cannot change what the booking recorded.
    "answers_at_booking",
    {
      columns: [
        attendeeIdColumn,
        ["question_id", wholeNumber],
        ["question_text", text],
        ["answer_id", wholeNumberOrNull],
        [
          "answer_text",
          checked(sql`(answer_text IS NULL) = (answer_id IS NULL)`)(textOrNull),
        ],
        [
          "free_text",
          checked(sql`free_text IS NULL OR answer_id IS NULL`)(textOrNull),
        ],
        [
          "free_text_index",
          checked(sql`(free_text_index IS NULL) = (free_text IS NULL)`)(
            textOrNull,
          ),
        ],
      ],
      indexes: [
        {
          columns: ["attendee_id", "question_id"],
          name: "idx_answers_at_booking_unique",
          unique: true,
        },
      ],
    },
  ],

  [
    "attendee_answers",
    {
      columns: [
        ["id", rowId],
        attendeeIdColumn,
        ["answer_id", wholeNumberOrNull],
        ["question_id", wholeNumberOrNull],
        ["string_id", wholeNumberOrNull],
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
        ["id", rowId],
        // The kinds come from NOTE_ENTITIES, so the stored values and the ones
        // the code accepts cannot drift apart.
        ["entity_type", oneOf("entity_type", NOTE_ENTITIES)(text)],
        ["entity_id", wholeNumber],
        ["type", oneOf("type", SYSTEM_NOTE_TYPES)(defaulted(text, "system"))],
        ["note", text],
        [
          "system_name",
          checked(
            sql`system_name IS NULL OR (type = 'system' AND system_name GLOB 'system-note:1:?*')`,
          )(textOrNull),
        ],
        ["created", text],
      ],
      indexes: [
        {
          columns: ["entity_type", "entity_id"],
          name: "idx_system_notes_entity",
        },
        {
          columns: ["entity_type", "entity_id", "system_name"],
          name: "idx_system_notes_named_unique",
          unique: true,
        },
      ],
    },
  ],
];

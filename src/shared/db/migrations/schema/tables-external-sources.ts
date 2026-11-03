/** The external sources directory: places records are also kept, and the
 *  records' ids there. */

import { EXTERNAL_LINK_KINDS } from "#db/external-sources/types.ts";
import { createdColumn } from "./scalar-columns.ts";
import type { Column, Table } from "./types.ts";

/** The generated key both directory tables carry. */
const idColumn: Column = ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"];

/** The record kinds a link can point at, as a CHECK the database enforces. */
const linkKindCheck = `link_type IN (${EXTERNAL_LINK_KINDS.map(
  (kind) => `'${kind}'`,
).join(", ")})`;

export const externalSourceTables: [name: string, table: Table][] = [
  [
    // A place this site's records also appear elsewhere, such as an invoice
    // system or a carrier. `name` and `url_pattern` hold owner-key ciphertext,
    // so only an admin session reads them.
    "external_sources",
    {
      columns: [
        idColumn,
        ["name", "TEXT NOT NULL"],
        ["url_pattern", "TEXT NOT NULL"],
        createdColumn,
      ],
    },
  ],

  [
    // One record's id at one source. `external_id` holds owner-key ciphertext
    // and `external_id_index` its blind index, so a lookup finds the row
    // without decrypting. Neither is set for a link made before the other
    // system named the record. No FKs (house style). Deleting a source deletes
    // its links in the same batch.
    "external_source_links",
    {
      columns: [
        idColumn,
        ["source_id", "INTEGER NOT NULL"],
        ["link_type", `TEXT NOT NULL CHECK (${linkKindCheck})`],
        ["link_id", "INTEGER NOT NULL"],
        ["external_id", "TEXT"],
        [
          "external_id_index",
          "TEXT CHECK ((external_id_index IS NULL) = (external_id IS NULL))",
        ],
        createdColumn,
      ],
      indexes: [
        {
          columns: ["source_id", "external_id_index"],
          name: "idx_external_source_links_external",
          unique: true,
        },
        {
          columns: ["link_type", "link_id"],
          name: "idx_external_source_links_target",
        },
      ],
    },
  ],
];

/** The external sources directory: places records are also kept, and the
 *  records' ids there. */

/* jscpd:ignore-start */
import { EXTERNAL_LINK_KINDS } from "#db/external-sources/types.ts";
import { sql } from "#db/sql.ts";
import { datedRowColumns } from "./columns.ts";
import {
  checked,
  oneOf,
  text,
  textOrNull,
  wholeNumber,
} from "./scalar-columns.ts";
import type { Table } from "./types.ts";

/* jscpd:ignore-end */

/** The record kinds a link can point at, as a CHECK the database enforces. */
const linkKind = oneOf("link_type", EXTERNAL_LINK_KINDS)(text);

export const externalSourceTables: [name: string, table: Table][] = [
  [
    // A place this site's records also appear elsewhere, such as an invoice
    // system or a carrier. `name` and `url_pattern` hold owner-key ciphertext,
    // so only an admin session reads them.
    "external_sources",
    {
      columns: [...datedRowColumns, ["name", text], ["url_pattern", text]],
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
        ...datedRowColumns,
        ["source_id", wholeNumber],
        ["link_type", linkKind],
        ["link_id", wholeNumber],
        ["external_id", textOrNull],
        [
          "external_id_index",
          checked(sql`(external_id_index IS NULL) = (external_id IS NULL)`)(
            textOrNull,
          ),
        ],
      ],
      indexes: [
        {
          columns: ["external_id_index"],
          name: "idx_external_source_links_lookup",
        },
        {
          // One external id can name several records: an invoice that covers a
          // group, a diary entry that runs over two listings. The same source
          // still cannot hold the same record under the same id twice.
          columns: ["source_id", "external_id_index", "link_type", "link_id"],
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

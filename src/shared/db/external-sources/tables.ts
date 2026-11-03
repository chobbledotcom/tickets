/**
 * The two tables of the external sources directory.
 *
 * A source is one place records also appear. A link is one record's id at that
 * place, found by its blind index without decrypting. The text columns carry
 * owner-key ciphertext at rest and read back as plain text through
 * ./sealing.ts.
 */

import type { BlindIndex } from "#crypto/sealed.ts";
import { idAndCreatedSchema } from "#db/common-schema.ts";
import { defineIdTable } from "#db/define-id-table.ts";
import { col } from "#db/table.ts";
import { nowIso } from "#shared/now.ts";
import { openForAdmin, sealForAdmin } from "./sealing.ts";
import type {
  ExternalLinkInput,
  ExternalSource,
  ExternalSourceInput,
  ExternalSourceLink,
} from "./types.ts";

/** The places records are also kept. */
export const externalSourcesTable = defineIdTable<
  ExternalSource,
  ExternalSourceInput
>("external_sources", {
  ...idAndCreatedSchema(nowIso),
  name: col.encrypted(sealForAdmin, openForAdmin),
  url_pattern: col.encrypted(sealForAdmin, openForAdmin),
});

/** One record's id at one source. `external_id_index` is the plain column that
 *  finds the row: a filter can compare it, and a ciphertext it cannot. */
export const externalSourceLinksTable = defineIdTable<
  ExternalSourceLink,
  ExternalLinkInput
>("external_source_links", {
  ...idAndCreatedSchema(nowIso),
  external_id: col.encrypted(sealForAdmin, openForAdmin),
  external_id_index: col.simple<BlindIndex>(),
  link_id: col.simple<number>(),
  link_type: col.simple<ExternalSourceLink["link_type"]>(),
  source_id: col.simple<number>(),
});

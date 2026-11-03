/**
 * What the external sources directory stores.
 *
 * A source is a place this site's records also appear: an invoice system, an
 * import, a carrier. A link points one attendee, listing, or group at its id
 * there. The source name, its URL pattern, and every external id are sealed
 * with the owner key, so only an admin session reads them.
 */

import * as v from "valibot";
import type { BlindIndex } from "#crypto/sealed.ts";

/** The kinds of record a link can point at. */
export const ExternalLinkKindSchema = v.picklist([
  "attendee",
  "listing",
  "group",
]);

export type ExternalLinkKind = v.InferOutput<typeof ExternalLinkKindSchema>;

export const EXTERNAL_LINK_KINDS = ExternalLinkKindSchema.options;

/** A stored source, opened for an admin. `url_pattern` is the source's own
 *  address format for one external id. */
export type ExternalSource = {
  created: string;
  id: number;
  name: string;
  url_pattern: string;
};

/** The fields a source write carries. */
export type ExternalSourceInput = {
  name: string;
  urlPattern: string;
};

/** A stored link, opened for an admin. `external_id_index` is the blind index
 *  that finds the row without decrypting, so it never reaches a response. */
export type ExternalSourceLink = {
  created: string;
  external_id: string;
  external_id_index: BlindIndex;
  id: number;
  link_id: number;
  link_type: ExternalLinkKind;
  source_id: number;
};

/** One link a caller asks to store. */
export type ExternalLinkWrite = {
  externalId: string;
  linkId: number;
  linkType: ExternalLinkKind;
};

/** The columns a link write stores, sealed and indexed. */
export type ExternalLinkInput = {
  externalId: string;
  externalIdIndex: BlindIndex;
  linkId: number;
  linkType: ExternalLinkKind;
  sourceId: number;
};

/** Which links one read asks for: all of a source's links, the one external id
 *  it holds, or the links of one record. */
export type ExternalLinkFilter =
  | { kind: "all" }
  | { externalId: string; kind: "external" }
  | { kind: "target"; linkId: number; linkType: ExternalLinkKind };

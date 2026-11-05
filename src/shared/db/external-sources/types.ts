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

/** The values a source's URL pattern can hold. A pattern with no placeholder
 *  is a plain destination address, such as a hand-off that creates the record
 *  there before it has an id. */
export const URL_PATTERN_PLACEHOLDERS = ["external_id"] as const;

/** The placeholder a link's external id fills. */
export const EXTERNAL_ID_PLACEHOLDER = `{${URL_PATTERN_PLACEHOLDERS[0]}}`;

const KNOWN_PLACEHOLDERS: readonly string[] = URL_PATTERN_PLACEHOLDERS;

const PLACEHOLDER = /\{([^{}]+)\}/g;

/** The placeholder names one pattern holds, in the order they appear. */
const placeholdersIn = (value: string): string[] =>
  [...value.matchAll(PLACEHOLDER)].map((match) => match[1] as string);

/** The address format one source uses for its records: http or https, with
 *  placeholders this directory can fill, each once, and none required. */
export const ExternalUrlPatternSchema = v.pipe(
  v.string(),
  v.regex(/^https?:\/\//i, "url_pattern must start with http:// or https://"),
  v.check(
    (value) =>
      placeholdersIn(value).every((name) => KNOWN_PLACEHOLDERS.includes(name)),
    `url_pattern can fill only ${URL_PATTERN_PLACEHOLDERS.map((name) => `{${name}}`).join(", ")}`,
  ),
  v.check(
    (value) =>
      new Set(placeholdersIn(value)).size === placeholdersIn(value).length,
    "url_pattern must hold each placeholder once",
  ),
);

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
 *  that finds the row without decrypting, so it never reaches a response. A
 *  link made before the other system named the record holds no id. */
export type ExternalSourceLink = {
  created: string;
  external_id: string | null;
  external_id_index: BlindIndex | null;
  id: number;
  link_id: number;
  link_type: ExternalLinkKind;
  source_id: number;
};

/** One link a caller asks to store. An absent external id means the other
 *  system has not named the record yet. */
export type ExternalLinkWrite = {
  externalId: string | null;
  linkId: number;
  linkType: ExternalLinkKind;
};

/** The columns a link write stores, sealed and indexed. The index stays empty
 *  while the external id does. */
export type ExternalLinkInput = {
  externalId: string | null;
  externalIdIndex: BlindIndex | null;
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

/**
 * The address a source's pattern gives one record.
 *
 * A pattern is what the source stores: a web address with the one placeholder
 * an external id fills. A link with no external id yet has no address.
 */

import { EXTERNAL_ID_PLACEHOLDER } from "./types.ts";

/** The address one record's external id gives at a source, or null while the
 *  other system has not named the record. The id is encoded, so an id that
 *  holds a slash or a space cannot change the address's shape. */
export const externalLinkUrl = (
  pattern: string,
  externalId: string | null,
): string | null =>
  externalId === null
    ? null
    : pattern.replace(EXTERNAL_ID_PLACEHOLDER, encodeURIComponent(externalId));

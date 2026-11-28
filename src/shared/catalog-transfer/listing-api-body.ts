// effects: pure
/**
 * The admin JSON API body for one catalog listing: the transfer's camelCase
 * fields under their snake_case wire keys, plus the link ids.
 *
 * The field keys come from `LISTING_FIELDS` and the link keys from
 * `LISTING_LINK_KEYS`. So a listing field has one spelling in the transfer
 * document and on the wire. This adapter holds no second field list.
 */

import { columnName, type SnakeCased } from "#shared/column-names.ts";
import {
  LISTING_FIELDS,
  LISTING_LINK_KEYS,
} from "#shared/records/listing-fields.ts";
import type { ListingData } from "./schema.ts";

/** The body of a listing create or update, keyed as the JSON API expects. */
export type ListingApiBody = SnakeCased<ListingData> & {
  attribute_option_ids?: number[];
  group_ids: number[];
};

/** The link ids one listing write carries. `null` option ids mean that the
 *  site has attributes turned off, so the body leaves the selection out. */
export type ListingApiLinks = {
  attributeOptionIds: readonly number[] | null;
  groupIds: readonly number[];
};

/** The input keys of one part of the body, checked against the table they
 *  must come from. */
const fieldKeys: ReadonlySet<string> = new Set(
  LISTING_FIELDS.map((field) => field.key),
);
const linkKeys: ReadonlySet<string> = new Set(
  LISTING_LINK_KEYS.map((link) => link.key),
);

/** Copy one input record into wire keys, refusing a key its table does not
 *  name. A clone keeps the caller's arrays out of the request body. */
const wireBody = (
  input: Readonly<Record<string, unknown>>,
  knownKeys: ReadonlySet<string>,
  what: string,
): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!knownKeys.has(key)) {
      throw new Error(
        `${key} is not a ${what}; add it to the table or omit it`,
      );
    }
    if (value === undefined) continue;
    body[columnName(key)] = Array.isArray(value) ? [...value] : value;
  }
  return body;
};

/** Map one listing's transfer data and link ids to the admin API body. */
export const listingApiBody = (
  data: ListingData,
  links: ListingApiLinks,
): ListingApiBody =>
  ({
    ...wireBody(data, fieldKeys, "listing field"),
    ...wireBody(
      {
        // Null option ids mean "leave the selection out", not "clear it".
        ...(links.attributeOptionIds === null
          ? {}
          : { attributeOptionIds: links.attributeOptionIds }),
        groupIds: links.groupIds,
      },
      linkKeys,
      "listing link",
    ),
  }) as ListingApiBody;

/** The listing admin API write bodies. They sit beside the listing fields, so
 *  the server's field read and the CLI's body check read one shape. The field
 *  views come from {@link LISTING_FIELDS}. The id lists and the update slug
 *  are the keys outside that list. */

import * as v from "valibot";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import {
  type ApiBody,
  apiBodyPair,
  textField,
} from "#shared/rest/api-body-fields.ts";
import { apiFieldsOf } from "#shared/rest/field-values.ts";
import { positiveIntegerSchema } from "#shared/validation/number.ts";

/** An optional list of positive integer ids. A non-array answers the label's
 *  own message. A bad entry fails closed rather than being dropped. */
const idList = (
  label: string,
  arrayMessage = `${label} must be an array`,
  entryMessage = `${label} must contain only positive integer ids`,
) => {
  const view = v.optional(
    v.array(positiveIntegerSchema(entryMessage), arrayMessage),
  );
  return { create: view, update: view };
};

/** A listing date: a UTC instant text, or null to clear it. The field read
 *  checks the instant itself, so both surfaces keep one date rule. */
const listingDateView = v.optional(
  v.nullable(v.string("date must be a UTC instant of a real calendar day")),
);
const listingDateViews = {
  create: listingDateView,
  update: listingDateView,
};

/** The listing name: a create answers the catalog mapper's empty-name
 *  message, which differs from the field's required message. */
const listingNameViews = textField(
  "name",
  "name is required",
  (text) => text.trim(),
  "name cannot be empty",
);

const listingBodies = apiBodyPair(
  {
    ...apiFieldsOf(LISTING_FIELDS),
    attribute_option_ids: idList("attribute_option_ids"),
    child_listing_ids: idList(
      "child_listing_ids",
      "child_listing_ids must be an array of listing ids",
      "child_listing_ids must contain only positive integer listing ids",
    ),
    date: listingDateViews,
    group_ids: idList("group_ids"),
    name: listingNameViews,
  },
  { updateOnly: { slug: v.string("slug must be a string") } },
);

/** The body a listing create accepts. */
export const CreateListingBodySchema = listingBodies.create;

/** The body a listing update accepts. */
export const UpdateListingBodySchema = listingBodies.update;

export type CreateListingBody = ApiBody<typeof CreateListingBodySchema>;
export type UpdateListingBody = ApiBody<typeof UpdateListingBodySchema>;

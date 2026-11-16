/**
 * The write body keys that no field list declares: the linked id lists, the
 * package members, and the slug an update can change. Each record is checked
 * against its body type, so a new body key without a row is a compile error.
 */

import type {
  PackageMemberBody,
  UpdateGroupBody,
} from "#routes/admin/api-groups.ts";
import type { UpdateListingBody } from "#routes/admin/api-listing-body.ts";
import type { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import type { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import type { FieldSpecs } from "#shared/rest/field-specs.ts";
import type { ExtraField, FieldLimit, ValueForm } from "./field-docs.ts";

/** The body keys a write takes beside its field list. */
type ExtraFields<Body, Fields extends FieldSpecs> = Record<
  Exclude<keyof Body, Fields[number]["key"]>,
  ExtraField
>;

/** A body key that links records by id. */
const idList = (limits: readonly FieldLimit[] = []): ExtraField => ({
  limits,
  value: { form: "listOf", of: { form: "wholeNumber", min: 1 } },
});

/** The slug an update can change. A create makes its own. */
const UPDATE_SLUG: ExtraField = {
  limits: [],
  only: "update",
  value: { form: "text" },
};

/** The keys of one package member. A key that the body type gains must be
 *  named here. */
const PACKAGE_MEMBER_KEYS = {
  day_prices: true,
  listing_id: true,
  price: true,
  quantity: true,
} satisfies Record<keyof PackageMemberBody, true>;

const PACKAGE_MEMBERS: ValueForm = {
  form: "listOf",
  of: { form: "object", names: Object.keys(PACKAGE_MEMBER_KEYS) },
};

/** Only an owner sets the attribute options of a listing. */
const LISTING_EXTRA_FIELDS = {
  attribute_option_ids: idList(["owner"]),
  child_listing_ids: idList(),
  group_ids: idList(),
  slug: UPDATE_SLUG,
} satisfies ExtraFields<UpdateListingBody, typeof LISTING_FIELDS>;

const GROUP_EXTRA_FIELDS = {
  package_members: { limits: [], value: PACKAGE_MEMBERS },
  slug: UPDATE_SLUG,
} satisfies ExtraFields<UpdateGroupBody, typeof GROUP_FIELDS>;

/** The extra body keys of each resource that has them, by resource path. */
export const EXTRA_FIELDS: Readonly<
  Record<string, Readonly<Record<string, ExtraField>>>
> = {
  groups: GROUP_EXTRA_FIELDS,
  listings: LISTING_EXTRA_FIELDS,
};

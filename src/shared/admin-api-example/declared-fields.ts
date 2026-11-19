/**
 * The write fields that field lists declare, by resource. Each resource also
 * names the body keys outside its list: the linked id lists, the package
 * members, and the slug an update can change. Those keys are checked against
 * the body type, so a new body key without a row is a compile error.
 */

import type {
  PackageMemberBody,
  UpdateGroupBody,
} from "#routes/admin/api-groups.ts";
import type { UpdateListingBody } from "#routes/admin/api-listing-body.ts";
import type { SnakeWord } from "#shared/column-names.ts";
import { ATTRIBUTE_FIELDS } from "#shared/records/attribute-fields.ts";
import { GROUP_FIELDS } from "#shared/records/group-fields.ts";
import { HOLIDAY_FIELDS } from "#shared/records/holiday-fields.ts";
import {
  LISTING_FIELDS,
  LISTING_WRITE_KEYS,
} from "#shared/records/listing-fields.ts";
import { STATUS_FIELDS } from "#shared/records/status-fields.ts";
import type { FieldSpecs, KeyAccess } from "#shared/rest/field-specs.ts";
import type { ExtraField, ValueForm } from "./field-docs.ts";

/** The body keys a write takes beside its field list. */
type ExtraFields<Body, Fields extends FieldSpecs> = Record<
  Exclude<keyof Body, SnakeWord<Fields[number]["key"]>>,
  ExtraField
>;

/** A body key that links records by id. */
const ID_LIST: ExtraField = {
  value: { form: "list_of", of: { form: "whole_number", min: 1 } },
};

/** The slug an update can change. A create makes its own. */
const UPDATE_SLUG: ExtraField = {
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
  form: "list_of",
  of: { form: "object", names: Object.keys(PACKAGE_MEMBER_KEYS) },
};

const LISTING_EXTRA_FIELDS = {
  attribute_option_ids: ID_LIST,
  child_listing_ids: ID_LIST,
  group_ids: ID_LIST,
  slug: UPDATE_SLUG,
} satisfies ExtraFields<UpdateListingBody, typeof LISTING_FIELDS>;

const GROUP_EXTRA_FIELDS = {
  package_members: { value: PACKAGE_MEMBERS },
  slug: UPDATE_SLUG,
} satisfies ExtraFields<UpdateGroupBody, typeof GROUP_FIELDS>;

/** The write fields one resource declares: its field list, and the body keys
 *  outside the list. `access` holds the access rule of every key that has
 *  one. The server reads the same rules when it refuses a write. */
export type DeclaredFields = {
  access: readonly KeyAccess[];
  extras: Readonly<Record<string, ExtraField>>;
  fields: FieldSpecs;
};

/** A resource whose only write keys are its field list. */
const listOnly = (fields: FieldSpecs): DeclaredFields => ({
  access: fields,
  extras: {},
  fields,
});

/** The declared write fields of each resource that has a field list, by
 *  resource path. A resource that is absent here declares its fields in the
 *  body schemas of the resource table. */
export const DECLARED_FIELDS: Readonly<Record<string, DeclaredFields>> = {
  "attendee-statuses": listOnly(STATUS_FIELDS),
  attributes: listOnly(ATTRIBUTE_FIELDS),
  groups: {
    access: GROUP_FIELDS,
    extras: GROUP_EXTRA_FIELDS,
    fields: GROUP_FIELDS,
  },
  holidays: listOnly(HOLIDAY_FIELDS),
  listings: {
    access: LISTING_WRITE_KEYS,
    extras: LISTING_EXTRA_FIELDS,
    fields: LISTING_FIELDS,
  },
};

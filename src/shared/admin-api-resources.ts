/**
 * The one admin JSON API contract: per resource, the URL path, the response
 * envelope keys, and valibot schemas for every wire shape. The server's route
 * factory, the CLI client, the tests, and the API docs page all read this
 * table. No side can disagree with another about a path or a shape (#2502).
 *
 * Types derive from the schemas with v.InferOutput — the schemas are the one
 * vocabulary for the wire shapes. The client validates every response against
 * them before it returns it.
 */

import * as v from "valibot";

/* ===========================================================================
 * Row schemas — the shapes the JSON API answers with. The client validates
 * the fields its callers read. The server owns the rest of each row, so the
 * row schemas stay open (looseObject) and small.
 * =========================================================================== */

/** The identity fields every admin API row carries: the server-owned id and
 *  the display name. */
const IdNameRow = {
  id: v.number(),
  name: v.string(),
};

/** One attribute option as the admin API answers with it. */
const AttributeOptionRowSchema = v.looseObject({
  id: v.number(),
  text: v.string(),
});

export const AttributeRowSchema = v.looseObject({
  ...IdNameRow,
  options: v.array(AttributeOptionRowSchema),
});

export type AdminApiAttribute = v.InferOutput<typeof AttributeRowSchema>;

export const GroupRowSchema = v.looseObject({
  ...IdNameRow,
  is_package: v.boolean(),
});

export type AdminApiGroup = v.InferOutput<typeof GroupRowSchema>;

/** The holiday fields a create or update write carries: the row without its
 *  server-owned id. */
export const HolidayWriteSchema = v.object({
  end_date: v.string(),
  name: v.string(),
  start_date: v.string(),
});
export type AdminApiCreateHolidayBody = v.InferOutput<
  typeof HolidayWriteSchema
>;

export const UpdateHolidayBodySchema = v.partial(HolidayWriteSchema);
export type AdminApiUpdateHolidayBody = v.InferOutput<
  typeof UpdateHolidayBodySchema
>;

/** One holiday as the server stores it: the writable fields plus its id. */
export const HolidayRowSchema = v.intersect([
  HolidayWriteSchema,
  v.object({ id: v.number() }),
]);

export type AdminApiHoliday = v.InferOutput<typeof HolidayRowSchema>;

/** One listing as the admin API answers with it: the fields the client's
 *  callers read. The server owns the rest of the stored row. */
export const ListingRowSchema = v.looseObject({
  ...IdNameRow,
  slug: v.string(),
});

export type AdminApiListing = v.InferOutput<typeof ListingRowSchema>;

/* ===========================================================================
 * Request body schemas — the shapes a caller sends. Bodies the server
 * validates against dynamic catalog fields (groups, listings) stay unknown.
 * The server is the validator. A static schema here gives a second
 * vocabulary for a shape the server owns.
 * =========================================================================== */

export const CreateAttributeBodySchema = v.object({ name: v.string() });
export type AdminApiCreateAttributeBody = v.InferOutput<
  typeof CreateAttributeBodySchema
>;

export const UpdateAttributeBodySchema = v.partial(
  v.object({ name: v.string() }),
);
export type AdminApiUpdateAttributeBody = v.InferOutput<
  typeof UpdateAttributeBodySchema
>;

/* ===========================================================================
 * The resource table.
 * =========================================================================== */

/** One nested CRUD surface under its parent resource, such as an attribute's
 *  options. The parent envelope (`responseSchema`) is what the child's write
 *  answers with — an option write answers with the whole attribute. */
export type AdminApiChild = {
  /** The child's URL segment under the parent's id segment: "options". */
  path: string;
  responseSchema: v.GenericSchema;
};

export type AdminApiResource = {
  children?: Record<string, AdminApiChild>;
  createBodySchema?: v.GenericSchema;
  /** The display name the server logs and confirms with ("Attribute"). The
   *  single-envelope key and the id param name derive from it lowercased. */
  label: string;
  listSchema: v.GenericSchema;
  path: string;
  singleSchema: v.GenericSchema;
  updateBodySchema?: v.GenericSchema;
};

const attributeEnvelope = v.looseObject({ attribute: AttributeRowSchema });

export const ADMIN_API_RESOURCES = {
  attributes: {
    children: {
      options: {
        path: "options",
        responseSchema: attributeEnvelope,
      },
    },
    createBodySchema: CreateAttributeBodySchema,
    label: "Attribute",
    listSchema: v.looseObject({ attributes: v.array(AttributeRowSchema) }),
    path: "attributes",
    singleSchema: attributeEnvelope,
    updateBodySchema: UpdateAttributeBodySchema,
  },
  groups: {
    label: "Group",
    listSchema: v.looseObject({ groups: v.array(GroupRowSchema) }),
    path: "groups",
    singleSchema: v.looseObject({ group: GroupRowSchema }),
  },
  holidays: {
    createBodySchema: HolidayWriteSchema,
    label: "Holiday",
    listSchema: v.looseObject({ holidays: v.array(HolidayRowSchema) }),
    path: "holidays",
    singleSchema: v.looseObject({ holiday: HolidayRowSchema }),
    updateBodySchema: UpdateHolidayBodySchema,
  },
  listings: {
    label: "Listing",
    listSchema: v.looseObject({
      listings: v.array(ListingRowSchema),
    }),
    path: "listings",
    singleSchema: v.looseObject({ listing: ListingRowSchema }),
  },
} as const satisfies Record<string, AdminApiResource>;

export type AdminApiResourceName = keyof typeof ADMIN_API_RESOURCES;

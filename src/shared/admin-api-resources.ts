/**
 * The one admin JSON API contract: per resource, the URL path, the response
 * envelope keys, and valibot schemas for every wire shape. The CLI client and
 * the tests read this table. No side can disagree with another about a path
 * or a shape (#2502).
 *
 * Types derive from the schemas with v.InferOutput — the schemas are the one
 * vocabulary for the wire shapes. The client validates every response against
 * them before it returns it.
 */

import * as v from "valibot";

import { QuestionDisplayTypeSchema } from "#db/question-types.ts";

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

/** The id-and-text pair a choice option row and a question row both carry. */
const IdTextRow = {
  id: v.number(),
  text: v.string(),
};

/** One choice option as the admin API answers with it: the server-owned id
 *  and its text. An attribute's options and a question's answers both read
 *  back in this shape. */
const OptionRowSchema = v.looseObject({ ...IdTextRow });

export const AttributeRowSchema = v.looseObject({
  ...IdNameRow,
  options: v.array(OptionRowSchema),
});

export type AdminApiAttribute = v.InferOutput<typeof AttributeRowSchema>;

/** One question as the admin API answers with it: the decrypted text, the
 *  display type, the assign-all switch, and its answers in display order.
 *  A question's display name is its text, so the row carries no separate
 *  name. */
export const QuestionRowSchema = v.looseObject({
  answers: v.array(OptionRowSchema),
  assign_all: v.boolean(),
  display_type: QuestionDisplayTypeSchema,
  ...IdTextRow,
});

export type AdminApiQuestion = v.InferOutput<typeof QuestionRowSchema>;

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

/** One holiday as the server stores it: the writable fields plus its id. The
 *  row schema stays open — the server owns the rest of the stored row. */
export const HolidayRowSchema = v.looseObject({
  ...HolidayWriteSchema.entries,
  id: v.number(),
});

export type AdminApiHoliday = v.InferOutput<typeof HolidayRowSchema>;

/** One listing as the admin API answers with it: the fields the client's
 *  callers read. The server owns the rest of the stored row. */
export const ListingRowSchema = v.looseObject({
  ...IdNameRow,
  slug: v.string(),
});

export type AdminApiListing = v.InferOutput<typeof ListingRowSchema>;

/** The fields an attendee-status create carries. The three flags and the
 *  reservation amount answer the stored-column defaults (off, "0") when a
 *  caller leaves them out. */
export const CreateAttendeeStatusBodySchema = v.object({
  is_paid_default: v.optional(v.boolean()),
  is_public_default: v.optional(v.boolean()),
  is_reservation: v.optional(v.boolean()),
  name: v.string(),
  reservation_amount: v.optional(v.string()),
});
export type AdminApiCreateAttendeeStatusBody = v.InferOutput<
  typeof CreateAttendeeStatusBodySchema
>;

/** The body an attendee-status update carries: every writable field optional. */
export const UpdateAttendeeStatusBodySchema = v.partial(
  v.object({
    is_paid_default: v.boolean(),
    is_public_default: v.boolean(),
    is_reservation: v.boolean(),
    name: v.string(),
    reservation_amount: v.string(),
  }),
);
export type AdminApiUpdateAttendeeStatusBody = v.InferOutput<
  typeof UpdateAttendeeStatusBodySchema
>;

/** One attendee status as the admin API answers with it: the writable fields
 *  plus its id. The row schema stays open — the server owns the rest of the
 *  stored row (its sort order). */
export const AttendeeStatusRowSchema = v.looseObject({
  ...UpdateAttendeeStatusBodySchema.entries,
  id: v.number(),
});

export type AdminApiAttendeeStatus = v.InferOutput<
  typeof AttendeeStatusRowSchema
>;

/** One attendee booking row as the admin API answers with it. The row schema
 *  stays open — the server owns the rest of the stored row. */
export const AttendeeRowSchema = v.looseObject({
  id: v.number(),
  listing_id: v.number(),
  name: v.string(),
  quantity: v.number(),
});

export type AdminApiAttendeeRow = v.InferOutput<typeof AttendeeRowSchema>;

/** The writable fields one site-page update carries, including the parent.
 *  The field list repeats the shape uptime-kuma's own schemas spell. The two
 *  domains share nothing, so the matcher's finding is marked. */
/* jscpd:ignore-start */
const SitePageUpdateFields = {
  content: v.string(),
  hidden: v.boolean(),
  meta_description: v.string(),
  meta_title: v.string(),
  name: v.string(),
  parent: v.nullable(v.number()),
  slug: v.string(),
};
/* jscpd:ignore-end */

/** The body a site-page update accepts: every writable field optional. */
export const UpdateSitePageBodySchema = v.partial(
  v.object(SitePageUpdateFields),
);

/** The body a site-page create accepts. A new page is always a root page, so
 *  the create body carries no parent. The server stores the form's defaults
 *  for a silent field (empty text, a visible page), so only the name and the
 *  slug are required. */
export const CreateSitePageBodySchema = v.partial(
  v.omit(v.object(SitePageUpdateFields), ["parent"]),
  ["content", "hidden", "meta_description", "meta_title"],
);

/** One site page as the admin API answers with it. A content page answers
 *  every field. A fixed page (home, contact and terms — not site_pages rows)
 *  answers only its name and its content. `parent` names the page this page
 *  nests under, null at the top level. */
export const SitePageRowSchema = v.looseObject({
  ...UpdateSitePageBodySchema.entries,
  id: v.optional(v.number()),
});

export type AdminApiSitePage = v.InferOutput<typeof SitePageRowSchema>;

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

/** One choice option's write body, on the attribute-option and answer
 *  surfaces alike. The server parses the same shape for the option's create
 *  and its update. */
export const OptionBodySchema = v.object({ text: v.string() });
export type AdminApiOptionBody = v.InferOutput<typeof OptionBodySchema>;

/** The body a question create carries: the text and the display type are
 *  required, the same two fields the question form requires. The assign-all
 *  switch is optional and defaults to off. */
export const CreateQuestionBodySchema = v.object({
  assign_all: v.optional(v.boolean()),
  display_type: QuestionDisplayTypeSchema,
  text: v.string(),
});
export type AdminApiCreateQuestionBody = v.InferOutput<
  typeof CreateQuestionBodySchema
>;

/** The body a question update carries: every writable field optional. */
export const UpdateQuestionBodySchema = v.partial(
  v.object({
    assign_all: v.boolean(),
    display_type: QuestionDisplayTypeSchema,
    text: v.string(),
  }),
);
export type AdminApiUpdateQuestionBody = v.InferOutput<
  typeof UpdateQuestionBodySchema
>;

/* ===========================================================================
 * The delete contract — one shape for every confirmed delete, root or child.
 * =========================================================================== */

/** The body every confirmed delete carries: the resource's current display
 *  name, so a delete cannot hit the wrong row. */
export const DeleteBodySchema = v.object({
  confirm_identifier: v.string(),
});
export type AdminApiDeleteBody = v.InferOutput<typeof DeleteBodySchema>;

/** The answer every confirmed delete carries. */
export const DeleteAnswerSchema = v.looseObject({ status: v.string() });
export type AdminApiDeleteAnswer = v.InferOutput<typeof DeleteAnswerSchema>;

/* ===========================================================================
 * The resource table.
 * =========================================================================== */

/** One nested CRUD surface under its parent resource, such as an attribute's
 *  options. The parent envelope (`responseSchema`) is what the child's write
 *  answers with — an option write answers with the whole attribute. */
export type AdminApiChild = {
  /** The child's write body. The server parses the same shape for the
   *  child's create and its update. Absent: the server is the validator. */
  bodySchema?: v.GenericSchema;
  /** The child's own id param in its update and delete routes: "optionId". */
  idParam: string;
  /** The child's URL segment under the parent's id segment: "options". */
  path: string;
  responseSchema: v.GenericSchema;
};

/** The id param a resource's routes use: the label lowercased plus "Id"
 *  ("Attribute" answers "attributeId"). */
export const adminApiIdParam = (label: string): string =>
  `${label.toLowerCase()}Id`;

/** A server-side custom route declared for the docs and the route keys. */
export type AdminApiCustomRoute = {
  method: "DELETE" | "GET" | "POST" | "PUT";
  /** The URL segment under the resource root, including the id param. */
  subpath: string;
};

/** Which of the five standard routes a resource serves. Absent means all five
 *  (list, get, create, update, delete). A create-only surface declares only
 *  the routes it answers. The route table, the CLI, and the docs then never
 *  offer a path the server 404s. */
export type AdminApiServes = {
  create?: boolean;
  delete?: boolean;
  get?: boolean;
  list?: boolean;
  update?: boolean;
};

export type AdminApiResource = {
  children?: Record<string, AdminApiChild>;
  /** Server-side custom routes. A `DELETE` on the resource's own id segment
   *  replaces the standard delete handler. */
  custom?: Record<string, AdminApiCustomRoute>;
  createBodySchema?: v.GenericSchema;
  /** The display name the server logs and confirms with ("Attribute"). The
   *  single-envelope key and the id param name derive from it lowercased. */
  label: string;
  /** Absent on a create-only resource that serves no collection route. */
  listSchema?: v.GenericSchema;
  path: string;
  /** The standard routes the resource serves, all five when absent. */
  serves?: AdminApiServes;
  singleSchema: v.GenericSchema;
  updateBodySchema?: v.GenericSchema;
};

const attributeEnvelope = v.looseObject({ attribute: AttributeRowSchema });

export const ADMIN_API_RESOURCES = {
  "attendee-statuses": {
    createBodySchema: CreateAttendeeStatusBodySchema,
    label: "Status",
    listSchema: v.looseObject({
      "attendee-statuses": v.array(AttendeeStatusRowSchema),
    }),
    path: "attendee-statuses",
    singleSchema: v.looseObject({ status: AttendeeStatusRowSchema }),
    updateBodySchema: UpdateAttendeeStatusBodySchema,
  },
  attendees: {
    // The create is the one standard route this surface serves. A booking
    // needs the server's full validation, so the table declares no client
    // body schema. The server owns the request shape.
    label: "Attendee",
    path: "attendees",
    serves: { create: true },
    singleSchema: v.looseObject({ attendee: AttendeeRowSchema }),
  },
  attributes: {
    children: {
      options: {
        bodySchema: OptionBodySchema,
        idParam: "optionId",
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
    custom: {
      attendees: {
        method: "GET",
        subpath: ":listingId/attendees",
      },
      deactivate: {
        method: "POST",
        subpath: ":listingId/deactivate",
      },
      delete: {
        method: "DELETE",
        subpath: ":listingId",
      },
      reactivate: {
        method: "POST",
        subpath: ":listingId/reactivate",
      },
    },
    label: "Listing",
    listSchema: v.looseObject({
      listings: v.array(ListingRowSchema),
    }),
    path: "listings",
    singleSchema: v.looseObject({ listing: ListingRowSchema }),
  },
  questions: {
    children: {
      answers: {
        bodySchema: OptionBodySchema,
        idParam: "answerId",
        path: "answers",
        responseSchema: v.looseObject({ question: QuestionRowSchema }),
      },
    },
    createBodySchema: CreateQuestionBodySchema,
    label: "Question",
    listSchema: v.looseObject({ questions: v.array(QuestionRowSchema) }),
    path: "questions",
    singleSchema: v.looseObject({ question: QuestionRowSchema }),
    updateBodySchema: UpdateQuestionBodySchema,
  },
  "site-pages": {
    createBodySchema: CreateSitePageBodySchema,
    label: "Page",
    listSchema: v.looseObject({
      "site-pages": v.array(SitePageRowSchema),
    }),
    path: "site-pages",
    singleSchema: v.looseObject({ page: SitePageRowSchema }),
    updateBodySchema: UpdateSitePageBodySchema,
  },
} as const satisfies Record<string, AdminApiResource>;

export type AdminApiResourceName = keyof typeof ADMIN_API_RESOURCES;

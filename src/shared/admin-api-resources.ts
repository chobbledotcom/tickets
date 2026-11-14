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

import {
  QuestionDisplayTypeSchema,
  questionDisplayTypeError,
} from "#db/question-types.ts";
import {
  CreateExternalLinkBodySchema,
  CreateExternalSourceBodySchema,
  ExternalSourceLinkRowSchema,
  ExternalSourceRowSchema,
  UpdateExternalSourceBodySchema,
} from "#shared/admin-api-external-sources.ts";
import {
  CreateImageBodySchema,
  ImageRowSchema,
  UpdateImageBodySchema,
} from "#shared/admin-api-images.ts";
import { ATTRIBUTE_FIELDS } from "#shared/records/attribute-fields.ts";
import { HOLIDAY_FIELDS } from "#shared/records/holiday-fields.ts";
import { STATUS_FIELDS } from "#shared/records/status-fields.ts";
import {
  type ApiBody,
  apiBodyPair,
  type BodyField,
  fieldViews,
  idRow,
  optionalTextField,
  picklistField,
  switchField,
  textField,
} from "#shared/rest/api-body-fields.ts";
import { apiFieldsOf, type FieldSpecs } from "#shared/rest/field-specs.ts";

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
 *  and its text. */
const OptionRowSchema = v.looseObject({ ...IdTextRow });

/** One answer as the admin API answers with it: its text and the stored
 *  selection total the question page shows ("Times selected"). The server owns
 *  the rest of the stored row. */
const AnswerRowSchema = v.looseObject({
  ...IdTextRow,
  times_selected: v.number(),
});

export const AttributeRowSchema = v.looseObject({
  ...IdNameRow,
  options: v.array(OptionRowSchema),
});

export type AdminApiAttribute = v.InferOutput<typeof AttributeRowSchema>;

/** One question as the admin API answers with it: the decrypted text, the
 *  display type, the assign-all switch, and its answers in display order. Each
 *  answer carries its selection total. A question's display name is its text,
 *  so the row carries no separate name. */
export const QuestionRowSchema = v.looseObject({
  answers: v.array(AnswerRowSchema),
  assign_all: v.boolean(),
  display_type: QuestionDisplayTypeSchema,
  ...IdTextRow,
});

export const GroupRowSchema = v.looseObject({
  ...IdNameRow,
  is_package: v.boolean(),
});

export type AdminApiGroup = v.InferOutput<typeof GroupRowSchema>;

/** One field list's API shapes: its write bodies, and its row with the
 *  server-owned id. `rowView` names the view the row reads. The row schema
 *  stays open, because the server owns the rest of the stored row. */
const fieldResource = <
  const Fields extends FieldSpecs,
  View extends keyof BodyField,
>(
  fields: Fields,
  rowView: View,
) => {
  const views = apiFieldsOf(fields);
  return {
    bodies: apiBodyPair(views),
    row: idRow(fieldViews(views, rowView)),
  };
};

const holidayApi = fieldResource(HOLIDAY_FIELDS, "create");
export const HolidayRowSchema = holidayApi.row;
export type AdminApiHoliday = v.InferOutput<typeof HolidayRowSchema>;

/** One listing as the admin API answers with it: the fields the client's
 *  callers read. The server owns the rest of the stored row. */
export const ListingRowSchema = v.looseObject({
  ...IdNameRow,
  slug: v.string(),
});

export type AdminApiListing = v.InferOutput<typeof ListingRowSchema>;

/** The three flags and the reservation amount of an attendee status answer
 *  the stored-column defaults (off, "0") when a create leaves them out. The
 *  row reads the update view, so it requires no flag. */
const attendeeStatusApi = fieldResource(STATUS_FIELDS, "update");
export const AttendeeStatusRowSchema = attendeeStatusApi.row;
export type AdminApiCreateAttendeeStatusBody = ApiBody<
  typeof attendeeStatusApi.bodies.create
>;
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

/** The writable fields one site-page body carries. The field list repeats the
 *  shape uptime-kuma's own schemas spell. The two domains share nothing, so
 *  the matcher's finding is marked. */
/* jscpd:ignore-start */
const sitePageFields = {
  content: optionalTextField("content"),
  hidden: switchField("hidden"),
  meta_description: optionalTextField("meta_description"),
  meta_title: optionalTextField("meta_title"),
  name: textField("name"),
  slug: textField("slug", "Slug is required"),
};
const sitePageBodies = apiBodyPair(sitePageFields, {
  updateOnly: {
    parent: v.nullable(v.number("parent must be a page id or null")),
  },
});
/* jscpd:ignore-end */

/** The body a site-page update accepts: every writable field optional. */
export const UpdateSitePageBodySchema = sitePageBodies.update;

/** The body a site-page create accepts. A new page is always a root page, so
 *  the create body carries no parent. The server stores the form's defaults
 *  for a silent field (empty text, a visible page), so only the name and the
 *  slug are required. */
export const CreateSitePageBodySchema = sitePageBodies.create;

/** One site page as the admin API answers with it. A content page answers
 *  every field. A fixed page (home, contact and terms — not site_pages rows)
 *  answers only its name and its content. `parent` names the page this page
 *  nests under, null at the top level. */
export const SitePageRowSchema = v.looseObject({
  ...fieldViews(sitePageFields, "update"),
  id: v.optional(v.number()),
  parent: v.nullable(v.number("parent must be a page id or null")),
});

export type AdminApiSitePage = v.InferOutput<typeof SitePageRowSchema>;

/* ===========================================================================
 * Request body schemas — the shapes a caller sends. Bodies the server
 * validates against dynamic catalog fields (groups, listings) stay unknown.
 * The server is the validator. A static schema here gives a second
 * vocabulary for a shape the server owns.
 * =========================================================================== */

const attributeBodies = apiBodyPair(apiFieldsOf(ATTRIBUTE_FIELDS));

/** One choice option's write body, on the attribute-option and answer
 *  surfaces alike. The server parses the same shape for the option's create
 *  and its update. */
export const OptionBodySchema = v.object({ text: v.string() });
export type AdminApiOptionBody = v.InferOutput<typeof OptionBodySchema>;

/** The body a question create carries: the text and the display type are
 *  required, the same two fields the question form requires. The assign-all
 *  switch is optional and defaults to off. */
const questionBodies = apiBodyPair({
  assign_all: switchField("assign_all"),
  display_type: picklistField(
    "display_type",
    QuestionDisplayTypeSchema.options,
    questionDisplayTypeError,
  ),
  text: textField("text"),
});
export type AdminApiCreateQuestionBody = ApiBody<typeof questionBodies.create>;
export type AdminApiUpdateQuestionBody = ApiBody<typeof questionBodies.update>;

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

/** One entry's shared table fields: its label, its path, and the two envelopes
 *  the server answers with. The list envelope is keyed by the path and the
 *  single envelope by the lowercased label, which is also how the id param is
 *  named. */
const resourceTableRow = <
  const Label extends string,
  const Path extends string,
  Row extends v.GenericSchema,
>(
  label: Label,
  path: Path,
  row: Row,
) => ({
  label,
  listSchema: v.looseObject({ [path]: v.array(row) } as {
    [K in Path]: v.ArraySchema<Row, undefined>;
  }),
  path,
  singleSchema: v.looseObject({ [label.toLowerCase()]: row } as {
    [K in Lowercase<Label>]: Row;
  }),
});

const attributeTableRow = resourceTableRow(
  "Attribute",
  "attributes",
  AttributeRowSchema,
);

export const ADMIN_API_RESOURCES = {
  "attendee-statuses": {
    createBodySchema: attendeeStatusApi.bodies.create,
    ...resourceTableRow("Status", "attendee-statuses", AttendeeStatusRowSchema),
    updateBodySchema: attendeeStatusApi.bodies.update,
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
        responseSchema: attributeTableRow.singleSchema,
      },
    },
    createBodySchema: attributeBodies.create,
    ...attributeTableRow,
    updateBodySchema: attributeBodies.update,
  },
  "external-sources": {
    children: {
      links: {
        bodySchema: CreateExternalLinkBodySchema,
        idParam: "linkId",
        path: "links",
        responseSchema: v.looseObject({
          link: ExternalSourceLinkRowSchema,
        }),
      },
    },
    createBodySchema: CreateExternalSourceBodySchema,
    // The read of one source's links, which a filter narrows by external id
    // or by the record they point at.
    custom: {
      // The read of every source's links for one record, then the read of one
      // source's links. The literal paths win over the id segment.
      linkLookup: { method: "GET", subpath: "lookup" },
      linkSearch: { method: "GET", subpath: "links" },
      links: { method: "GET", subpath: ":sourceId/links" },
    },
    ...resourceTableRow("Source", "external-sources", ExternalSourceRowSchema),
    updateBodySchema: UpdateExternalSourceBodySchema,
  },
  groups: {
    ...resourceTableRow("Group", "groups", GroupRowSchema),
  },
  holidays: {
    createBodySchema: holidayApi.bodies.create,
    ...resourceTableRow("Holiday", "holidays", HolidayRowSchema),
    updateBodySchema: holidayApi.bodies.update,
  },
  images: {
    createBodySchema: CreateImageBodySchema,
    ...resourceTableRow("Image", "images", ImageRowSchema),
    updateBodySchema: UpdateImageBodySchema,
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
    ...resourceTableRow("Listing", "listings", ListingRowSchema),
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
    createBodySchema: questionBodies.create,
    custom: {
      // The bookings that answered the question: the read side of the
      // attendee-answers link, newest booking first.
      bookings: { method: "GET", subpath: ":questionId/bookings" },
    },
    ...resourceTableRow("Question", "questions", QuestionRowSchema),
    updateBodySchema: questionBodies.update,
  },
  "site-pages": {
    createBodySchema: CreateSitePageBodySchema,
    custom: {
      // The fixed pages (home, contact and terms) are not site_pages rows.
      // They are addressed by name: a client reads and updates each page's
      // content. A fixed page cannot be created, deleted, or hidden, so the
      // read and update verbs answer normally and the other two refuse.
      "contact-delete": { method: "DELETE", subpath: "contact" },
      "contact-get": { method: "GET", subpath: "contact" },
      "contact-post": { method: "POST", subpath: "contact" },
      "contact-put": { method: "PUT", subpath: "contact" },
      "home-delete": { method: "DELETE", subpath: "home" },
      "home-get": { method: "GET", subpath: "home" },
      "home-post": { method: "POST", subpath: "home" },
      "home-put": { method: "PUT", subpath: "home" },
      "terms-delete": { method: "DELETE", subpath: "terms" },
      "terms-get": { method: "GET", subpath: "terms" },
      "terms-post": { method: "POST", subpath: "terms" },
      "terms-put": { method: "PUT", subpath: "terms" },
    },
    ...resourceTableRow("Page", "site-pages", SitePageRowSchema),
    updateBodySchema: UpdateSitePageBodySchema,
  },
} as const satisfies Record<string, AdminApiResource>;

export type AdminApiResourceName = keyof typeof ADMIN_API_RESOURCES;

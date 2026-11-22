import * as v from "valibot";
import type { ExtraField } from "#shared/admin-api-example/field-docs.ts";
import { listOfObjects, TEXT } from "#shared/admin-api-example/value-forms.ts";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

/**
 * Request schemas for the public JSON API's booking bodies — the ONE
 * declaration of each accepted shape. The route handlers parse against these.
 * The documented examples in admin-api-example.ts are validated through them,
 * so the docs can never drift from what the endpoints accept.
 */

/** A positive integer accepted as a JSON number or a digit string ("2"). */
export const ApiQuantitySchema = v.pipe(
  v.union([v.number(), v.pipe(v.string(), v.digits(), v.transform(Number))]),
  v.integer(),
  v.minValue(1),
);

/** One `children` entry of a booking body — declared once as a schema. The
 * accepted shape, its validation (a NaN/garbage `customPrice` is a parse error,
 * never a stored price), and the {@link ApiChildSelection} type stay one
 * artifact. The package book endpoint layers a required `parent` member slug on
 * top ({@link PackageChildrenSchema}). An absent `children` field is an empty
 * selection: the fold auto-fills a sole child, or rejects a multi-child parent
 * with a "choose more" error. */
const childSelectionEntries = {
  customPrice: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  parent: v.optional(NonEmptyTextSchema),
  quantity: ApiQuantitySchema,
  slug: NonEmptyTextSchema,
};

export const ChildrenSchema = v.nullish(
  v.array(v.object(childSelectionEntries)),
  [],
);
export const PackageChildrenSchema = v.nullish(
  v.array(v.object({ ...childSelectionEntries, parent: NonEmptyTextSchema })),
  [],
);

export type ApiChildSelection = v.InferOutput<
  ReturnType<typeof v.object<typeof childSelectionEntries>>
>;

/** The fields a public booking body takes. The listing's contact setting
 *  decides which of the four contact keys it must carry, beside the name. A
 *  listing booked per date also needs `date`. */
const PUBLIC_BOOKING_FIELDS = {
  address: { value: TEXT },
  children: { value: listOfObjects(Object.keys(childSelectionEntries)) },
  date: { value: { form: "date" } },
  email: { value: TEXT },
  name: { required: true, value: TEXT },
  phone: { value: TEXT },
  quantity: {
    required: true,
    value: { form: "whole_number", min: 1 },
  },
  special_instructions: { value: TEXT },
} as const satisfies Record<string, ExtraField>;

/** The body keys of POST /api/listings/:slug/book. A pay-more listing takes
 *  `customPrice`, a price in minor units. */
export const LISTING_BOOKING_FIELDS = {
  ...PUBLIC_BOOKING_FIELDS,
  customPrice: { value: { form: "price" } },
} as const satisfies Record<string, ExtraField>;

/** The body keys of POST /api/packages/:slug/book. A bundle with customisable
 *  days takes `dayCount`. Each `children` entry names its `parent` member. */
export const PACKAGE_BOOKING_FIELDS = {
  ...PUBLIC_BOOKING_FIELDS,
  dayCount: { value: { form: "whole_number", min: 1 } },
} as const satisfies Record<string, ExtraField>;

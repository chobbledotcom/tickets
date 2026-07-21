import * as v from "valibot";
import { NonEmptyTextSchema } from "#shared/validation/string.ts";

/**
 * Request schemas for the public JSON API's booking bodies — the ONE
 * declaration of each accepted shape. The route handlers parse against these,
 * and the documented examples in admin-api-example.ts are validated through
 * them, so the docs can never drift from what the endpoints accept.
 */

/** A positive integer accepted as a JSON number or a digit string ("2"). */
export const ApiQuantitySchema = v.pipe(
  v.union([v.number(), v.pipe(v.string(), v.digits(), v.transform(Number))]),
  v.integer(),
  v.minValue(1),
);

/** One `children` entry of a booking body — declared once as a schema, so the
 * accepted shape, its validation (a NaN/garbage `customPrice` is a parse error,
 * never a stored price), and the {@link ApiChildSelection} type stay one
 * artifact. The package book endpoint layers a required `parent` member slug on
 * top ({@link PackageChildrenSchema}); an absent `children` field is an empty
 * selection (the fold auto-fills a sole child, or rejects a multi-child parent
 * with a "choose more" error). */
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

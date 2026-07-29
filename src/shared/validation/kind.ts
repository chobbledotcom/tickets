import * as v from "valibot";

/** A choice that is only its own name — one arm of a "which of these is it"
 *  list, where naming it is all there is to say. Arms that carry more than
 *  their name are written out in full instead. */
export const kindObject = <const Kind extends string>(
  kind: Kind,
): v.StrictObjectSchema<
  { readonly kind: v.LiteralSchema<Kind, undefined> },
  undefined
> => v.strictObject({ kind: v.literal(kind) });

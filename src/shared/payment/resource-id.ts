import * as v from "valibot";

/**
 * A provider's id for a charge or a refund.
 *
 * A real resource id is non-empty text — `""` is the boundary's marker for "no
 * resource" (a free session that captured no money), so a charge or refund that
 * claims a resource must carry something other than whitespace. The live payment
 * path refuses a paid session whose provider gave a blank id, rather than
 * treating the blank as a refundable charge the way the old per-provider parsing
 * did.
 */
export const ResourceIdSchema = v.pipe(
  v.string(),
  v.nonEmpty(),
  v.regex(/\S/u, "Resource id must contain text"),
);
export type ResourceId = v.InferOutput<typeof ResourceIdSchema>;

/** Whether a string is a real provider resource id (non-empty, with text). */
export const isResourceId = (value: string): value is ResourceId =>
  v.is(ResourceIdSchema, value);

import * as v from "valibot";

/**
 * A provider's id for a charge or a refund.
 *
 * A real resource id is text with no space around it — `""` is the boundary's
 * marker for "no resource" (a free session that captured no money), so a charge
 * or refund that claims a resource must carry something more.
 *
 * Padding is refused rather than trimmed: the id is stored and sent back to the
 * provider exactly as it arrived, and `" pi_123 "` names no charge the provider
 * can find, so a padded id would be booked as refundable and then fail every
 * refund. Trimming would guess at what the provider meant.
 */
const ResourceIdSchema = v.pipe(
  v.string(),
  v.regex(/^\S(?:.*\S)?$/u, "Resource id must be text with no space around it"),
);
type ResourceId = v.InferOutput<typeof ResourceIdSchema>;

/** Whether a string is a real provider resource id. */
export const isResourceId = (value: string): value is ResourceId =>
  v.is(ResourceIdSchema, value);

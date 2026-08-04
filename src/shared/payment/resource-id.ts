import * as v from "valibot";

/**
 * A provider's id for a charge or a refund. Whitespace is refused rather than
 * trimmed, because the id goes back to the provider exactly as it arrived and
 * `" pi_123"` names no charge it can find. `""` is the boundary's marker for a
 * session that captured no money.
 */
const ResourceIdSchema = v.pipe(
  v.string(),
  v.regex(/^\S+$/u, "Resource id must be text with no whitespace"),
);
type ResourceId = v.InferOutput<typeof ResourceIdSchema>;

/** Whether a string is a real provider resource id. */
export const isResourceId = (value: string): value is ResourceId =>
  v.is(ResourceIdSchema, value);

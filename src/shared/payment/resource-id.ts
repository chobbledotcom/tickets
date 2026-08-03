import * as v from "valibot";

/**
 * A provider's id for a charge or a refund.
 *
 * A real resource id is unbroken text — `""` is the boundary's marker for "no
 * resource" (a free session that captured no money), so a charge or refund that
 * claims a resource must carry something more.
 *
 * No whitespace anywhere, and it is refused rather than trimmed: the id goes
 * back to the provider exactly as it arrived, and `" pi_123"` or `"pi 123"`
 * names no charge it can find. Accepting one books the session as refundable
 * and then fails every refund attempt, so the webhook retries for good.
 */
const ResourceIdSchema = v.pipe(
  v.string(),
  v.regex(/^\S+$/u, "Resource id must be text with no whitespace"),
);
type ResourceId = v.InferOutput<typeof ResourceIdSchema>;

/** Whether a string is a real provider resource id. */
export const isResourceId = (value: string): value is ResourceId =>
  v.is(ResourceIdSchema, value);

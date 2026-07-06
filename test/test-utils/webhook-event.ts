/**
 * Builder for the webhook event envelope both payment providers deliver — a
 * `{ data: { object }, id, type }` shape. The `object` payload differs per
 * provider (a Stripe checkout session, a Square payment), so it stays a
 * caller-supplied value while the envelope is shared.
 */

/** Wrap a provider payload in the shared webhook envelope. */
export const webhookEvent = <T>(
  object: T,
  id: string,
  type: string,
): { data: { object: T }; id: string; type: string } => ({
  data: { object },
  id,
  type,
});

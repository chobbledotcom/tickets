/**
 * What one read of a payment provider's records can come back as. Every read
 * lands in exactly one of four states, so a caller can never confuse "the
 * provider says this does not exist" with "the provider could not answer" or
 * "the answer contradicts our own facts" — three situations that need three
 * different responses (give up, retry, refuse).
 *
 * SumUp's reads use this today; M6 moves Stripe and Square behind the same
 * vocabulary.
 */

/** Why the provider could not answer at all. Retrying can help. */
type ProviderUnavailableReason =
  | "network_error"
  | "not_configured"
  | "provider_error";

/**
 * Why an answer the provider did give was refused. The answer either broke
 * its own documented shape, or it disagreed with facts we hold independently
 * — the id we asked for, the account we are bound to, or the charges the
 * record itself names.
 */
export type ProviderInvalidReason =
  | "malformed_response"
  | "mismatched_account"
  | "mismatched_id"
  | "missing_documented_resource"
  | "unrecorded_child"
  | "unsupported_status";

/** One provider read: the resource, or exactly one reason there isn't one. */
export type ProviderRead<Resource> =
  | { status: "found"; resource: Resource }
  | { status: "missing" }
  | { status: "unavailable"; reason: ProviderUnavailableReason }
  | { status: "invalid"; reason: ProviderInvalidReason };

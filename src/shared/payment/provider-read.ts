/**
 * What one read of a payment provider's records can come back as. Every read
 * lands in exactly one of four states, so a caller can never confuse "the
 * provider says this does not exist" with "the provider could not answer" or
 * "the answer contradicts our own facts" — three situations that need three
 * different responses (give up, retry, refuse).
 *
 * Every payment adapter uses this vocabulary at its provider boundary.
 */

/** Why the provider could not answer at all. Retrying can help. */
export type ProviderUnavailableReason =
  | "network_error"
  | "not_configured"
  | "provider_error"
  | "rate_limited"
  | "timeout";

/**
 * Why an answer the provider did give was refused. The provider rejected the
 * request, broke its documented shape, or disagreed with facts we hold
 * independently.
 */
export type ProviderInvalidReason =
  | "malformed_money"
  | "malformed_response"
  | "mismatched_account"
  | "mismatched_id"
  | "mismatched_money"
  | "mismatched_parent"
  | "missing_documented_resource"
  | "multiple_pending_refunds"
  | "rejected_request"
  | "unrecorded_child"
  | "unsupported_status";

/** One provider read: the resource, or exactly one reason there isn't one. */
export type ProviderRead<Resource> =
  | { status: "found"; resource: Resource }
  | { status: "missing" }
  | { status: "unavailable"; reason: ProviderUnavailableReason }
  | { status: "invalid"; reason: ProviderInvalidReason };

export type ProviderReader<Resource> = (
  reference: string,
) => Promise<ProviderRead<Resource>>;

/** Build a reader that turns provider resources into one shared domain shape.
 * Missing, unavailable, and invalid remain exact; the source member is resolved
 * inside the callback so test stubs and live credential changes stay visible. */
export const mapProviderReader =
  <Input, Output>(
    read: ProviderReader<Input>,
    mapFound: (resource: Input) => ProviderRead<Output>,
  ): ProviderReader<Output> =>
  async (reference) => {
    const answer = await read(reference);
    return answer.status === "found" ? mapFound(answer.resource) : answer;
  };

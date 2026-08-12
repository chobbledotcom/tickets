/** Every HTTP answer the shared provider boundary classifies for reads. */
export const providerReadHttpCases = [
  [400, { reason: "rejected_request", status: "invalid" }],
  [401, { reason: "provider_error", status: "unavailable" }],
  [403, { reason: "provider_error", status: "unavailable" }],
  [404, { status: "missing" }],
  [408, { reason: "timeout", status: "unavailable" }],
  [409, { reason: "provider_error", status: "unavailable" }],
  [422, { reason: "rejected_request", status: "invalid" }],
  [429, { reason: "rate_limited", status: "unavailable" }],
  [500, { reason: "provider_error", status: "unavailable" }],
  [504, { reason: "timeout", status: "unavailable" }],
] as const;

/** Every HTTP answer the shared provider boundary classifies after a send. */
export const providerRefundHttpCases = [
  [399, { kind: "uncertain", reason: "provider_error" }],
  [400, { kind: "rejected", reason: "rejected" }],
  [404, { kind: "rejected", reason: "rejected" }],
  [408, { kind: "uncertain", reason: "timeout" }],
  [409, { kind: "uncertain", reason: "provider_error" }],
  [429, { kind: "uncertain", reason: "rate_limited" }],
  [499, { kind: "rejected", reason: "rejected" }],
  [500, { kind: "uncertain", reason: "provider_error" }],
  [504, { kind: "uncertain", reason: "timeout" }],
] as const;

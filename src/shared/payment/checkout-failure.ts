import type { PaymentProviderType } from "#types";

type ProviderCheckoutFailure =
  | { readonly reason: "provider_error"; readonly statusCode: number }
  | {
      readonly reason: "invalid_response";
      readonly statusCode?: number | undefined;
    }
  | { readonly reason: "network_error" | "timeout" };

type ProviderCheckoutFailureReason = ProviderCheckoutFailure["reason"];

/** Closed provider facts safe to pass through the global diagnostic boundary. */
export class ProviderCheckoutError extends Error {
  readonly provider: PaymentProviderType;
  readonly reason: ProviderCheckoutFailureReason;
  readonly statusCode: number | undefined;

  constructor(provider: PaymentProviderType, failure: ProviderCheckoutFailure) {
    const statusCode = "statusCode" in failure ? failure.statusCode : undefined;
    super(
      `${provider} checkout failed (${failure.reason}${
        statusCode === undefined ? "" : `:${statusCode}`
      })`,
    );
    this.name = "ProviderCheckoutError";
    this.provider = provider;
    this.reason = failure.reason;
    this.statusCode = statusCode;
  }
}

/** The only provider-error shapes checkout code may expose to callers. */
export const checkoutFailure = {
  connection: (
    provider: PaymentProviderType,
    reason: "network_error" | "timeout",
  ): ProviderCheckoutError => new ProviderCheckoutError(provider, { reason }),
  invalidResponse: (
    provider: PaymentProviderType,
    statusCode?: number,
  ): ProviderCheckoutError =>
    new ProviderCheckoutError(provider, {
      reason: "invalid_response",
      statusCode,
    }),
  provider: (
    provider: PaymentProviderType,
    statusCode: number,
  ): ProviderCheckoutError =>
    new ProviderCheckoutError(provider, {
      reason: "provider_error",
      statusCode,
    }),
};

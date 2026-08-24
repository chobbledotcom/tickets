import type { ProviderFailureFacts } from "#payment/provider-failures.ts";
import { ProviderTransportError } from "#payment/transport-error.ts";
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

/** The checkout meaning of one transport failure. An unreadable answer stays
 * an unreadable answer even when a status came with it, so this asks
 * `malformed` before the status — otherwise a provider that answers 502 with
 * a broken body would be reported as a plain provider error. */
export const checkoutErrorFrom = (
  provider: PaymentProviderType,
  { connectionReason, malformed, statusCode }: ProviderFailureFacts,
): ProviderCheckoutError => {
  if (malformed === true) {
    return checkoutFailure.invalidResponse(provider, statusCode);
  }
  if (statusCode !== undefined) {
    return checkoutFailure.provider(provider, statusCode);
  }
  if (connectionReason !== undefined) {
    return checkoutFailure.connection(provider, connectionReason);
  }
  throw new Error(`${provider} transport failure carries no facts`);
};

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

/** The checkout mapper every provider runs its calls under: a transport
 * failure becomes closed provider facts, and anything else is a bug in our own
 * code, so it keeps travelling. */
export const closedCheckoutErrorFor =
  (provider: PaymentProviderType) =>
  (error: unknown): ProviderCheckoutError => {
    if (!(error instanceof ProviderTransportError)) throw error;
    return checkoutErrorFrom(provider, error.facts);
  };

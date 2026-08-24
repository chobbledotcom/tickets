/**
 * One provider's transport failing, in the facts every reader already wants.
 *
 * Three providers each grew their own Api/Connection/Protocol trio, and all
 * eight classes said one of exactly three things: the provider answered with
 * a status, we never reached it, or its answer was not usable. Those three
 * are {@link ProviderFailureFacts}, so the classes were eight spellings of a
 * type that already existed. This is the one spelling.
 *
 * What a provider genuinely owns rides along in `detail`: the buyer field
 * Square rejected, the code and request id Stripe returns. A provider with
 * nothing of its own carries only its name.
 */

import type { ProviderFailureFacts } from "#payment/provider-failures.ts";
import { isAbortOrTimeoutError, namedError } from "#shared/named-error.ts";
import type { PaymentProviderType } from "#types";

/** A buyer field a provider can reject with a message safe to show them. */
export type RejectedBuyerField = "email" | "phone";

/** Why we could not reach a provider at all. */
export type ProviderConnectionReason = "network_error" | "timeout";

/** What one provider knows about its own failure beyond the shared facts. */
export type ProviderErrorDetail =
  | {
      readonly provider: "square";
      /** The buyer field Square named, or null when it named none. */
      readonly rejectedField: RejectedBuyerField | null;
    }
  | {
      readonly provider: "stripe";
      readonly code: string | undefined;
      readonly requestId: string | undefined;
      readonly type: string | undefined;
    }
  | { readonly provider: "sumup" };

/** A provider's transport failing, told in facts the shared readers accept. */
export class ProviderTransportError extends namedError(
  "ProviderTransportError",
) {
  constructor(
    readonly detail: ProviderErrorDetail,
    readonly facts: ProviderFailureFacts,
    message: string,
  ) {
    super(message);
  }

  /** The provider that failed. Its detail already names it, so this reads
   * that rather than storing the same fact twice. */
  get provider(): PaymentProviderType {
    return this.detail.provider;
  }
}

/** What each provider attaches to its own failures. One home, so a provider
 * builds its detail the same way wherever the failure is raised. */
export const providerDetail = {
  square: (
    rejectedField: RejectedBuyerField | null = null,
  ): ProviderErrorDetail => ({ provider: "square", rejectedField }),

  stripe: (
    fields: {
      code?: string | undefined;
      requestId?: string | undefined;
      type?: string | undefined;
    } = {},
  ): ProviderErrorDetail => ({
    code: fields.code,
    provider: "stripe",
    requestId: fields.requestId,
    type: fields.type,
  }),

  sumup: (): ProviderErrorDetail => ({ provider: "sumup" }),
} as const;

/** The three ways a provider transport can fail, each naming its own facts.
 * Every provider raises its failures through these, so no reader has to know
 * which provider it is looking at. */
export const transportError = {
  /** The provider answered, and its status is the verdict.
   *
   * `message` is the provider's own wording, and only a provider that has
   * proved its wording safe to carry passes one: Stripe's endpoint setup
   * reads it back to spot the webhook cap. Square passes none, because its
   * error body quotes the request. */
  answered: (
    detail: ProviderErrorDetail,
    statusCode: number,
    message?: string,
  ): ProviderTransportError =>
    new ProviderTransportError(
      detail,
      { statusCode },
      // A provider that hands back nothing useful gets our wording.
      message || `${detail.provider} answered. Status code: ${statusCode}`,
    ),

  /** We never got an answer. A provider may pass its own wording when that
   * says something an operator needs, such as the timeout it waited or the
   * retries it spent. */
  unreachable: (
    detail: ProviderErrorDetail,
    connectionReason: ProviderConnectionReason,
    message?: string,
  ): ProviderTransportError =>
    new ProviderTransportError(
      detail,
      { connectionReason },
      message ||
        (connectionReason === "timeout"
          ? `${detail.provider} did not answer in time`
          : `${detail.provider} could not be reached`),
    ),

  /** The provider answered, but its body was not the shape it documents.
   * `malformed` is set whether or not a status came with it: the read and
   * refund meanings take the status when there is one, while checkout needs
   * to know the answer itself was unreadable. */
  unusable: (
    detail: ProviderErrorDetail,
    statusCode?: number,
    message?: string,
  ): ProviderTransportError =>
    new ProviderTransportError(
      detail,
      { malformed: true, ...(statusCode === undefined ? {} : { statusCode }) },
      message || `${detail.provider} returned an answer we could not read`,
    ),
} as const;

/** The buyer field the provider named, or null when it named none. Only
 * Square reports one today; the rest have nothing to say about the buyer. */
export const rejectedBuyerFieldOf = (
  error: ProviderTransportError,
): RejectedBuyerField | null =>
  error.detail.provider === "square" ? error.detail.rejectedField : null;

/** The transport facts a caught error proves, or undefined when it proves
 * none — an internal bug the caller must let through rather than claim. */
export const transportFactsOf = (
  error: unknown,
): ProviderFailureFacts | undefined =>
  error instanceof ProviderTransportError ? error.facts : undefined;

/** Why a fetch failed before the provider answered, or undefined when the
 * error is not a transport failure at all.
 *
 * Every provider aborts through `AbortSignal.timeout`, so an abort is a
 * timeout here whatever name the runtime gives it. */
export const connectionReasonOf = (
  error: unknown,
): ProviderConnectionReason | undefined =>
  isAbortOrTimeoutError(error)
    ? "timeout"
    : error instanceof TypeError
      ? "network_error"
      : undefined;

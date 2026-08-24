/**
 * The one HTTP boundary every payment provider is asked through.
 *
 * A provider call can fail in three ways, and each way means something
 * different to the caller: we never reached the provider, the provider
 * answered and refused, or the answer cannot be read. This module gives all
 * three the shared {@link ProviderTransportError} vocabulary, so no adapter
 * has to classify a raw `TypeError` or a `SyntaxError` for itself.
 */

/* jscpd:ignore-start -- imports */
import { PROVIDER_TIMEOUT_MS } from "#payment/provider-timeout.ts";
import {
  connectionReasonOf,
  type ProviderErrorDetail,
  transportError,
} from "#payment/transport-error.ts";
import { fetchText } from "#shared/fetch.ts";

/* jscpd:ignore-end */

/** How one provider is named when its answer, or the lack of one, is refused.
 *  The answer body is passed in because a provider can name the field it
 *  rejected there, and that is the one fact the buyer can act on. */
type ProviderErrorDetailOf = (body: string) => ProviderErrorDetail;

/** One request to a provider. The boundary owns the signal, so no caller can
 *  ask without the shared timeout. */
export type ProviderRequest = Omit<RequestInit, "signal">;

/** One provider's HTTP boundary: every call it makes, named the same way. */
export type ProviderCaller = {
  /** Ask for one answer and hand back its body, whatever is in it. */
  text: (url: string, init: ProviderRequest) => Promise<string>;
  /** Ask for one answer and read it as JSON. */
  json: (url: string, init: ProviderRequest) => Promise<unknown>;
};

/** Read one provider answer as JSON. An answer we cannot read is unusable,
 *  whatever status came with it. */
export const readProviderJson = (
  detail: ProviderErrorDetail,
  body: string,
): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    throw transportError.unusable(detail);
  }
};

/** Bind one provider's name to the shared boundary. Every call it then makes
 *  runs under the shared timeout, counts against the edge subrequest budget,
 *  and tells each way of failing in the shared transport vocabulary. */
export const providerCaller = (
  namedBy: ProviderErrorDetailOf,
): ProviderCaller => {
  const text = async (url: string, init: ProviderRequest): Promise<string> => {
    const response = await fetchText(url, {
      ...init,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    }).catch((error: unknown) => {
      const reason = connectionReasonOf(error);
      if (reason === undefined) throw error;
      throw transportError.unreachable(namedBy(""), reason);
    });
    if (!response.ok) {
      throw transportError.answered(namedBy(response.text), response.status);
    }
    return response.text;
  };
  return {
    json: async (url, init) =>
      readProviderJson(namedBy(""), await text(url, init)),
    text,
  };
};

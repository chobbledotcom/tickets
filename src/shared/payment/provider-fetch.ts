/**
 * The one HTTP boundary every payment provider is asked through.
 *
 * A provider call can fail in three ways, and each way means something
 * different to the caller: we never reached the provider, the provider
 * answered and refused, or the answer cannot be read. This module gives all
 * three the shared {@link ProviderTransportError} vocabulary, so no adapter
 * has to classify a raw `TypeError` or a `SyntaxError` for itself.
 *
 * A provider that asks again after a failure declares its own
 * {@link ProviderRetries} rules. The ladder that spends them is here, so every
 * provider waits, counts, and gives up the same way.
 */

/* jscpd:ignore-start -- imports */
import { PROVIDER_TIMEOUT_MS } from "#payment/provider-timeout.ts";
import {
  connectionReasonOf,
  type ProviderConnectionReason,
  type ProviderErrorDetail,
  transportError,
} from "#payment/transport-error.ts";
import { type FetchResult, fetchText } from "#shared/fetch.ts";
import { delay } from "#shared/now.ts";

/* jscpd:ignore-end */

/** How one provider is named when its answer, or the lack of one, is refused.
 *  The answer body is passed in because a provider can name the field it
 *  rejected there, and that is the one fact the buyer can act on. */
type ProviderErrorDetailOf = (body: string) => ProviderErrorDetail;

/** One request to a provider. The boundary owns the signal, so no caller can
 *  ask without the shared timeout. */
export type ProviderRequest = Omit<RequestInit, "signal">;

/** When one provider is worth asking again, and how long to wait first. A
 *  provider that declares none is asked exactly once. */
export type ProviderRetries = {
  /** Whether this answer is worth asking for again. */
  readonly again: (answer: FetchResult) => boolean;
  /** How many more times to ask after the first attempt. */
  readonly limit: number;
  /** How long to wait before the attempt that follows attempt `retry`. The
   *  answer is null when the provider was never reached. */
  readonly waitBefore: (retry: number, answer: FetchResult | null) => number;
};

/** One provider's HTTP boundary: every call it makes, named the same way. */
export type ProviderCaller = {
  /** Ask for one answer and hand back all of it, refused or not. A provider
   *  that reads its own refusals starts here. */
  answer: (url: string, init: ProviderRequest) => Promise<FetchResult>;
  /** Ask for one answer and hand back its body, whatever is in it. */
  text: (url: string, init: ProviderRequest) => Promise<string>;
  /** Ask for one answer and read it as JSON. */
  json: (url: string, init: ProviderRequest) => Promise<unknown>;
};

/** One attempt: the provider's answer, or why we never reached it. */
type Attempt =
  | { readonly answer: FetchResult; readonly unreachable: null }
  | { readonly answer: null; readonly unreachable: ProviderConnectionReason };

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

const askOnce = async (
  url: string,
  init: ProviderRequest,
): Promise<Attempt> => {
  try {
    const answer = await fetchText(url, {
      ...init,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    return { answer, unreachable: null };
  } catch (error) {
    const unreachable = connectionReasonOf(error);
    // Anything else is a bug of ours rather than a provider gone quiet.
    if (unreachable === undefined) throw error;
    return { answer: null, unreachable };
  }
};

/** Bind one provider's name to the shared boundary. Every call it then makes
 * runs under the shared timeout, counts against the edge subrequest budget,
 * and tells each way of failing in the shared transport vocabulary. */
export const providerCaller = (
  namedBy: ProviderErrorDetailOf,
  retries?: ProviderRetries,
): ProviderCaller => {
  /** The wait before asking again, or null when this attempt was the last. A
   *  provider we never reached is always worth asking again while the limit
   *  allows, so only an answer gets a say. */
  const waitBeforeRetry = (
    retry: number,
    answer: FetchResult | null,
  ): number | null => {
    if (retries === undefined || retry >= retries.limit) return null;
    if (answer !== null && !retries.again(answer)) return null;
    return retries.waitBefore(retry, answer);
  };

  const answer = async (
    url: string,
    init: ProviderRequest,
  ): Promise<FetchResult> => {
    const attemptFrom = async (retry: number): Promise<FetchResult> => {
      const attempt = await askOnce(url, init);
      const wait = waitBeforeRetry(retry, attempt.answer);
      if (wait !== null) {
        await delay(wait);
        return attemptFrom(retry + 1);
      }
      if (attempt.unreachable !== null) {
        throw transportError.unreachable(namedBy(""), attempt.unreachable);
      }
      return attempt.answer;
    };
    return attemptFrom(0);
  };

  const text = async (url: string, init: ProviderRequest): Promise<string> => {
    const given = await answer(url, init);
    if (!given.ok) {
      throw transportError.answered(namedBy(given.text), given.status);
    }
    return given.text;
  };

  return {
    answer,
    json: async (url, init) =>
      readProviderJson(namedBy(""), await text(url, init)),
    text,
  };
};

import * as v from "valibot";
import {
  type ProviderRetries,
  providerCaller,
} from "#payment/provider-fetch.ts";
import {
  type ProviderTransportError,
  providerDetail,
  transportError,
} from "#payment/transport-error.ts";
import type { FetchResult } from "#shared/fetch.ts";
import { encodeStripeForm, type StripeFormValue } from "./form.ts";
import { parseStripeErrorBody } from "./schemas.ts";

export const STRIPE_API_VERSION = "2026-04-22.dahlia";
export const STRIPE_MAX_NETWORK_RETRIES = 2;

const STRIPE_API_URL = "https://api.stripe.com";
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 5_000;
const MAX_RETRY_AFTER_SECONDS = 60;

type StripeParams = Readonly<Record<string, StripeFormValue>>;
type Method = "DELETE" | "GET" | "POST";
type ResponseSchema<T> = v.BaseSchema<unknown, T, v.BaseIssue<unknown>>;

/** One call to the Stripe API: what to ask for, and the shape to read back. */
type StripeRequest = <T>(
  method: Method,
  path: string,
  params: StripeParams,
  schema: ResponseSchema<T>,
  options?: StripeRequestOptions,
) => Promise<T>;

/**
 * Per-request options. `idempotencyKey` overrides the default per-POST retry
 * key so a caller can supply the durable refund generation's stable key across
 * process retries (see `refundIdempotencyKey` in
 * `#shared/payment-idempotency.ts`). `maxNetworkRetries` narrows one bounded
 * workflow without weakening retries for unrelated Stripe calls.
 */
export interface StripeRequestOptions {
  idempotencyKey?: string | undefined;
  maxNetworkRetries?: 0 | undefined;
}

export interface StripeClientConfig {
  apiBase?: string;
  maxNetworkRetries?: number;
}

const retryDelay = (retry: number, retryAfter: string | null): number => {
  const jittered =
    INITIAL_RETRY_MS * 2 ** (retry - 1) * 0.5 * (1 + Math.random());
  const base = Math.min(MAX_RETRY_MS, Math.max(INITIAL_RETRY_MS, jittered));
  if (retryAfter === null) return base;
  const retryAfterSeconds = Number(retryAfter);
  return Number.isInteger(retryAfterSeconds) &&
    retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS
    ? Math.max(base, retryAfterSeconds * 1000)
    : base;
};

const shouldRetry = (answer: FetchResult): boolean => {
  const requested = answer.headers.get("stripe-should-retry");
  if (requested === "false") return false;
  if (requested === "true") return true;
  return answer.status === 409 || answer.status >= 500;
};

/**
 * Stripe returns HTTP 429 with `error.code === "lock_timeout"` when two
 * concurrent requests contend on the same resource (e.g. a refund racing a
 * webhook). Stripe's own SDK and the rate-limits docs both treat these as
 * retryable. Without a retry, replacing stripe-node can make a retryable
 * refund or PaymentIntent lookup fail immediately instead of using the
 * configured retry budget. The rate-limit 429 (no lock_timeout) is NOT
 * retried here — Stripe marks those with `stripe-should-retry` when it wants
 * a retry, otherwise they should surface immediately.
 *
 * https://docs.stripe.com/rate-limits#object-lock-timeouts
 */
const isLockTimeout = ({ status, text }: FetchResult): boolean => {
  if (status !== 429) return false;
  let body: { error?: { code?: unknown; type?: unknown } };
  try {
    body = JSON.parse(text);
  } catch {
    // A 429 we cannot read is a rate limit, and Stripe marks the rate limits
    // it wants another attempt for with `stripe-should-retry`.
    return false;
  }
  return (
    body?.error?.code === "lock_timeout" || body?.error?.type === "lock_timeout"
  );
};

/** Stripe's own rules for asking again, spent by the shared boundary. */
const stripeRetries = (limit: number): ProviderRetries => ({
  again: (answer) => shouldRetry(answer) || isLockTimeout(answer),
  limit,
  waitBefore: (retry, answer) =>
    retryDelay(
      retry,
      answer === null ? null : answer.headers.get("retry-after"),
    ),
});

const headerOrUndefined = (
  headers: Headers,
  name: string,
): string | undefined => {
  const value = headers.get(name);
  return value === null ? undefined : value;
};

/** The two ways one Stripe answer can be unreadable. */
const unusableAnswer = (
  statusCode: number | undefined,
  problem: "json" | "shape",
): ProviderTransportError =>
  transportError.unusable(
    providerDetail.stripe(),
    statusCode,
    problem === "json"
      ? "Invalid JSON received from the Stripe API"
      : "Invalid response received from the Stripe API",
  );

/** Refuse one answer Stripe did not accept, in the words Stripe used. An
 *  error body we cannot read is unusable instead, because there is no refusal
 *  to quote. */
const refuseAnswer = (answer: FetchResult): never => {
  let parsed: ReturnType<typeof parseStripeErrorBody>;
  try {
    parsed = parseStripeErrorBody(answer.text);
  } catch (error) {
    throw unusableAnswer(
      answer.status,
      error instanceof SyntaxError ? "json" : "shape",
    );
  }
  throw transportError.answered(
    providerDetail.stripe({
      code: parsed.error.code,
      requestId: headerOrUndefined(answer.headers, "request-id"),
      type: parsed.error.type,
    }),
    answer.status,
    parsed.error.message,
  );
};

const readAnswer = <T>(answer: FetchResult, schema: ResponseSchema<T>): T => {
  if (!answer.ok) refuseAnswer(answer);
  let body: unknown;
  try {
    body = JSON.parse(answer.text);
  } catch {
    throw unusableAnswer(undefined, "json");
  }
  try {
    return v.parse(schema, body);
  } catch {
    throw unusableAnswer(undefined, "shape");
  }
};

/** Where one call goes. A GET carries its form on the query string. */
const requestUrl = (
  apiBase: string,
  method: Method,
  path: string,
  encoded: string,
): string =>
  `${apiBase}${path}${method === "GET" && encoded ? `?${encoded}` : ""}`;

/** The key that lands a repeated POST on the original operation. A caller's
 *  own key wins; otherwise only a POST that may be asked again needs one. */
const idempotencyKeyFor = (
  method: Method,
  retries: number,
  given: string | undefined,
): string | undefined =>
  given ??
  (method === "POST" && retries > 0
    ? `tickets-stripe-retry-${crypto.randomUUID()}`
    : undefined);

const requestHeaders = (
  secretKey: string,
  idempotencyKey: string | undefined,
): Headers => {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Stripe-Version": STRIPE_API_VERSION,
  });
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return headers;
};

/** Build the versioned Stripe request transport with bounded retries. */
export const createStripeRequest = (
  secretKey: string,
  {
    apiBase = STRIPE_API_URL,
    maxNetworkRetries = STRIPE_MAX_NETWORK_RETRIES,
  }: StripeClientConfig = {},
): StripeRequest => {
  const namedBy = () => providerDetail.stripe();
  const askOnce = providerCaller(namedBy);
  const askAgain = providerCaller(namedBy, stripeRetries(maxNetworkRetries));

  return async (method, path, params, schema, options = {}) => {
    const retries = options.maxNetworkRetries ?? maxNetworkRetries;
    const encoded = encodeStripeForm(params);
    const answer = await (retries > 0 ? askAgain : askOnce).answer(
      requestUrl(apiBase, method, path, encoded),
      {
        ...(method === "POST" ? { body: encoded } : {}),
        headers: requestHeaders(
          secretKey,
          idempotencyKeyFor(method, retries, options.idempotencyKey),
        ),
        method,
      },
    );
    return readAnswer(answer, schema);
  };
};
